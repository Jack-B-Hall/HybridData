"""Telemetry logging, thumbs feedback, and the streaming-lock regression.

The lock test reproduces the production wedge: before the fix, ``ask_stream``
held the engine mutex across the entire generation, so a client that abandoned a
stream mid-answer left the lock held and every later ask blocked forever.
"""
from __future__ import annotations

import threading

from hde.config import Settings
from hde.engine import Engine
from hde.llm import MockLLM


class _GatedLLM:
    """A model whose stream yields one chunk then suspends — lets a test hold a
    stream open mid-generation without racing a real model."""

    name = "mock/gated"

    def __init__(self) -> None:
        self.started = threading.Event()

    def synthesize(self, request):
        return MockLLM().synthesize(request)

    def synthesize_stream(self, request):
        self.started.set()
        yield "Partial streamed answer so far "
        # Only reached if advanced again; the test abandons before this.
        yield "and the rest of the answer."


def _completes_within(fn, seconds: float):
    """Run ``fn`` in a thread; return its result, or None if it didn't finish."""
    box: dict = {}
    t = threading.Thread(target=lambda: box.setdefault("r", fn()), daemon=True)
    t.start()
    t.join(seconds)
    return None if t.is_alive() else box.get("r")


def test_abandoned_stream_does_not_wedge_the_engine(tiny_engine):
    # Use a shared (multi-thread) connection, exactly as the serving API does, so
    # a concurrent ask can run on another thread while the stream is suspended.
    s = tiny_engine.settings
    engine = Engine(
        Settings(db_path=s.db_path, telemetry_db=s.telemetry_db, embedder="hash", llm_backend="mock"),
        shared=True, llm=_GatedLLM(),
    )
    try:
        gen = engine.ask_stream("What chemistry is the battery pack?")
        saw_token = False
        for ev in gen:
            if ev["type"] == "token":
                saw_token = True
                break  # abandon the stream while it is mid-generation
        assert saw_token, "stream never reached token generation"

        # `gen` is suspended mid-answer. With the old whole-generation lock this
        # held the engine mutex; a second ask must still complete promptly.
        result = _completes_within(lambda: engine.ask("structural frame"), 5.0)
        assert result is not None, "second ask hung — the stream is holding the engine lock"

        gen.close()
    finally:
        engine.close()


def test_blocking_ask_is_logged_with_id(tiny_engine):
    result = tiny_engine.ask("What chemistry is the battery pack?")
    assert result.ask_id > 0
    health = tiny_engine.telemetry_health()
    assert health["totals"]["asks"] >= 1
    assert health["totals"]["answered"] >= 1
    assert "p50_ms" in health["latency"] and "p95_ms" in health["latency"]


def test_stream_done_event_carries_ask_id(tiny_engine):
    events = list(tiny_engine.ask_stream("What chemistry is the battery pack?"))
    done = events[-1]
    assert done["type"] == "done"
    assert done["result"]["ask_id"] > 0


def test_refusal_is_logged_as_unanswered(tiny_engine):
    result = tiny_engine.ask("What is the population of Japan?")
    assert result.answered is False and result.ask_id > 0
    assert tiny_engine.telemetry_health()["totals"]["refused"] >= 1


def test_feedback_ties_to_ask_and_rejects_unknown(tiny_engine):
    result = tiny_engine.ask("What chemistry is the battery pack?")
    assert tiny_engine.submit_feedback(result.ask_id, "down", "wanted more detail")
    assert tiny_engine.submit_feedback(9_999_999, "up") is None  # unknown ask
    health = tiny_engine.telemetry_health()
    assert health["feedback"]["down"] >= 1
    recent = health["recent"][0]
    assert recent["id"] == result.ask_id and recent["feedback"] == "down"


def test_abandoned_stream_is_logged(tiny_engine):
    tiny_engine.llm = _GatedLLM()
    gen = tiny_engine.ask_stream("What chemistry is the battery pack?")
    for ev in gen:
        if ev["type"] == "token":
            break
    gen.close()  # abandon → GeneratorExit → logged as 'abandoned'
    assert tiny_engine.telemetry_health()["totals"]["abandoned"] >= 1
