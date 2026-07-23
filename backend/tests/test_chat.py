"""Multi-turn chat: condensation, history bounding, per-turn gate, and the API."""
from __future__ import annotations

import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from hde import chat
from hde.api.app import app
from hde.ids import ID_RE
from hde.llm import MockLLM
from hde.telemetry import Telemetry


def _turn(message="q", answer="a", cited=None, answered=True):
    return chat.HistoryTurn(
        message=message, answer=answer, cited_ids=cited or [], answered=answered
    )


# ── condensation heuristic ───────────────────────────────────────────────────
def test_needs_rewrite_pronoun_follow_up():
    assert chat.needs_rewrite("what does it depend on?", ID_RE) is True
    assert chat.needs_rewrite("who approved that?", ID_RE) is True


def test_needs_rewrite_short_elliptical():
    assert chat.needs_rewrite("and the motors?", ID_RE) is True


def test_needs_rewrite_standalone_question():
    assert chat.needs_rewrite("why was the battery chemistry changed to LiFePO4?", ID_RE) is False


def test_needs_rewrite_id_anchored_message():
    # A record id anchors the message even when it also contains a pronoun.
    assert chat.needs_rewrite("what does ECR-214 change and why does it matter?", ID_RE) is False


def test_condense_standalone_passes_through():
    window = [_turn(cited=["ECR-214"])]
    out = chat.condense(MockLLM(), "why was the battery chemistry changed to LiFePO4?", window, ID_RE)
    assert out.method == "raw"
    assert out.question == "why was the battery chemistry changed to LiFePO4?"


def test_condense_empty_history_passes_through():
    out = chat.condense(MockLLM(), "what does it depend on?", [], ID_RE)
    assert out.method == "raw"


def test_condense_mock_rewrite_appends_recent_cited_ids():
    window = [
        _turn("first", "about A-1. [1]", cited=["A-1"]),
        _turn("second", "about D-1 and T-1. [1][2]", cited=["D-1", "T-1"]),
    ]
    out = chat.condense(MockLLM(), "what does it depend on?", window, ID_RE)
    assert out.method == "mock"
    # Anchored to the MOST RECENT turn's cited ids, not the older turn's.
    assert "D-1" in out.question and "T-1" in out.question
    assert "A-1" not in out.question
    assert out.question.startswith("what does it depend on?")


def test_condense_mock_rewrite_falls_back_to_ids_in_text():
    # A refused turn cites nothing; ids named in the raw message still anchor.
    window = [_turn("tell me about D-1", "declined", cited=[], answered=False)]
    out = chat.condense(MockLLM(), "why though?", window, ID_RE)
    assert "D-1" in out.question


def test_condense_mock_rewrite_no_ids_anywhere_is_raw():
    window = [_turn("hello there", "hi, ask about the corpus", cited=[])]
    out = chat.condense(MockLLM(), "what about it?", window, ID_RE)
    assert out.method == "raw"
    assert out.question == "what about it?"


class _RewriteLLM:
    """A fake non-mock backend for the LLM condensation path."""

    name = "ollama/fake"

    def __init__(self, reply=None, exc=None, delay=0.0):
        self.reply = reply
        self.exc = exc
        self.delay = delay

    def synthesize(self, request):
        if self.delay:
            time.sleep(self.delay)
        if self.exc:
            raise self.exc
        return self.reply

    def synthesize_stream(self, request):
        yield self.synthesize(request)


def test_condense_llm_rewrite_used_when_clean():
    llm = _RewriteLLM(reply='"What parts does the Power Module A-2 depend on?"\n')
    out = chat.condense(llm, "what does it depend on?", [_turn(cited=["A-2"])], ID_RE)
    assert out.method == "llm"
    assert out.question == "What parts does the Power Module A-2 depend on?"


def test_condense_llm_failure_falls_back_to_raw():
    llm = _RewriteLLM(exc=ConnectionError("host down"))
    out = chat.condense(llm, "what does it depend on?", [_turn(cited=["A-2"])], ID_RE)
    assert out.method == "raw"
    assert out.question == "what does it depend on?"


def test_condense_llm_timeout_falls_back_to_raw():
    llm = _RewriteLLM(reply="too late", delay=1.0)
    out = chat.condense(
        llm, "what does it depend on?", [_turn(cited=["A-2"])], ID_RE, timeout_s=0.05
    )
    assert out.method == "raw"
    assert out.question == "what does it depend on?"


def test_condense_llm_runaway_reply_falls_back():
    llm = _RewriteLLM(reply="blah " * 200)
    out = chat.condense(llm, "what does it depend on?", [_turn(cited=["A-2"])], ID_RE)
    assert out.method == "raw"


# ── history bounding ─────────────────────────────────────────────────────────
def test_bound_history_caps_turn_count():
    turns = [_turn(f"q{i}", f"a{i}") for i in range(10)]
    window = chat.bound_history(turns, max_turns=6, char_budget=100_000)
    assert [t.message for t in window] == [f"q{i}" for i in range(4, 10)]


def test_bound_history_caps_total_characters_keeping_newest():
    turns = [_turn(f"q{i}", "x" * 300) for i in range(6)]
    window = chat.bound_history(turns, max_turns=6, char_budget=650)
    # Only the newest ~two turns fit the budget; the newest is always kept.
    assert 1 <= len(window) <= 2
    assert window[-1].message == "q5"


def test_bound_history_clips_long_answers_per_turn():
    turns = [_turn("q", "y" * 5000)]
    window = chat.bound_history(turns, max_turns=6, char_budget=100_000)
    assert len(window[0].answer) == chat.TURN_ANSWER_CLIP


def test_render_history_block_marks_refusals():
    block = chat.render_history_block(
        [_turn("covered?", "yes [1]"), _turn("off-corpus?", "", answered=False)]
    )
    assert "Turn 1 user: covered?" in block
    assert "declined" in block


# ── telemetry persistence ────────────────────────────────────────────────────
def test_conversation_crud_and_turn_logging(tmp_path):
    tel = Telemetry(tmp_path / "t.db")
    convo = tel.create_conversation()
    cid = convo["id"]
    assert tel.conversation_exists(cid)

    tid = tel.log_chat_turn({
        "conversation_id": cid, "ts": None, "message": "first question",
        "rewritten": "first question", "rewrite_method": "raw", "ask_id": 1,
        "answered": 1, "verdict": "sufficient", "confidence": "high",
        "answer": "an answer [1]", "cited_ids": ["D-1"],
        "result": {"answer": "an answer [1]"}, "latency_ms": 5,
        "backend": "mock/mock", "status": "ok", "error": None,
    })
    assert tid

    detail = tel.get_conversation(cid)
    assert detail["n_turns"] == 1
    assert detail["title"] == "first question"  # inherited from the first message
    turn = detail["turns"][0]
    assert turn["cited_ids"] == ["D-1"]
    assert turn["result"]["answer"] == "an answer [1]"
    assert turn["answered"] is True

    assert tel.rename_conversation(cid, "Battery chat") is True
    assert tel.get_conversation(cid)["title"] == "Battery chat"

    listing = tel.list_conversations()
    assert listing[0]["id"] == cid and listing[0]["n_turns"] == 1

    assert tel.delete_conversation(cid) is True
    assert tel.get_conversation(cid) is None
    assert tel.delete_conversation(cid) is False
    tel.close()


def test_old_telemetry_volume_gains_chat_tables(tmp_path):
    # A pre-chat telemetry DB (asks only) upgrades cleanly on open, per the
    # CREATE IF NOT EXISTS + _migrate pattern.
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE asks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, question TEXT NOT NULL)")
    conn.commit()
    conn.close()

    tel = Telemetry(db)
    cid = tel.create_conversation("upgraded")["id"]
    assert tel.conversation_exists(cid)
    tel.close()


# ── engine multi-turn pipeline ───────────────────────────────────────────────
def test_chat_follow_up_rewrites_and_retrieves_fresh(tiny_engine):
    cid = tiny_engine.create_conversation()["id"]
    first = tiny_engine.chat_turn(cid, "What chemistry is the battery pack?")
    assert first["answered"] is True
    assert first["rewrite_method"] == "raw"
    assert first["result"]["sources"]

    follow = tiny_engine.chat_turn(cid, "what does it depend on?")
    # The rewrite anchored the pronoun follow-up to the previously-cited records.
    assert follow["rewrite_method"] == "mock"
    assert any(aid in follow["rewritten"] for aid in first["cited_ids"])
    # Fresh evidence was retrieved for THIS turn (not answered from history).
    assert follow["result"]["sources"]
    assert follow["answered"] is True


def test_chat_gate_refuses_mid_conversation_and_recovers(tiny_engine):
    cid = tiny_engine.create_conversation()["id"]
    ok1 = tiny_engine.chat_turn(cid, "What chemistry is the battery pack?")
    assert ok1["answered"] is True

    refused = tiny_engine.chat_turn(cid, "What is the population of Japan right now?")
    assert refused["answered"] is False
    assert refused["verdict"] == "insufficient"
    assert refused["result"]["answered"] is False

    # The conversation keeps working after a refusal.
    ok2 = tiny_engine.chat_turn(cid, "Describe the power module specification document.")
    assert ok2["answered"] is True
    assert tiny_engine.get_conversation(cid)["n_turns"] == 3


def test_chat_stream_event_order_and_rewrite_event(tiny_engine):
    cid = tiny_engine.create_conversation()["id"]
    tiny_engine.chat_turn(cid, "What chemistry is the battery pack?")
    events = list(tiny_engine.chat_turn_stream(cid, "what does it depend on?"))
    types = [e["type"] for e in events]
    assert types[0] == "rewrite"
    assert types[1] == "retrieval"
    assert types[-1] == "done"
    assert "token" in types
    assert "(context:" in events[0]["rewritten"]
    done = events[-1]["turn"]
    assert done["rewritten"] == events[0]["rewritten"]
    assert done["result"]["citations"]


def test_chat_history_window_respects_configured_turn_cap(tmp_path):
    from hde.config import Settings
    from hde.engine import Engine
    from conftest import _TinyAdapter
    from hde.ingest import ingest

    settings = Settings(
        db_path=tmp_path / "tiny.db", telemetry_db=tmp_path / "telemetry.db",
        embedder="hash", llm_backend="mock", chat_history_turns=2,
    )
    ingest(_TinyAdapter(), settings, reset=True)
    eng = Engine(settings)
    try:
        cid = eng.create_conversation()["id"]
        for i in range(4):
            eng.chat_turn(cid, f"Describe the power module specification document ({i}).")
        window = eng._chat_window(cid)
        assert len(window) == 2
        assert window[-1].message.endswith("(3).")
    finally:
        eng.close()


class _DownLLM:
    """Streams fail as if the model host is unreachable."""

    name = "ollama/down"

    def synthesize(self, request):
        raise ConnectionError("model host unreachable")

    def synthesize_stream(self, request):
        raise ConnectionError("model host unreachable")
        yield  # pragma: no cover


def test_chat_llm_host_down_gives_clean_per_turn_error(tmp_path):
    from hde.config import Settings
    from hde.engine import Engine
    from conftest import _TinyAdapter
    from hde.ingest import ingest

    settings = Settings(
        db_path=tmp_path / "tiny.db", telemetry_db=tmp_path / "telemetry.db",
        embedder="hash", llm_backend="mock",
    )
    ingest(_TinyAdapter(), settings, reset=True)
    eng = Engine(settings, llm=_DownLLM())
    try:
        cid = eng.create_conversation()["id"]
        events = list(eng.chat_turn_stream(cid, "What chemistry is the battery pack?"))
        assert events[-1]["type"] == "error"
        assert "unreachable" in events[-1]["message"]
        # The failed turn is recorded, and the conversation remains usable.
        detail = eng.get_conversation(cid)
        assert detail["turns"][-1]["status"] == "error"
        with pytest.raises(RuntimeError):
            eng.chat_turn(cid, "What chemistry is the battery pack?")
    finally:
        eng.close()


# ── HTTP API ─────────────────────────────────────────────────────────────────
@pytest.fixture
def chat_client(tiny_engine, monkeypatch):
    from hde import engine as engine_mod

    monkeypatch.setattr(engine_mod, "get_settings", lambda: tiny_engine.settings)
    from hde.api import app as app_mod

    monkeypatch.setattr(app_mod, "get_settings", lambda: tiny_engine.settings)
    with TestClient(app) as c:
        yield c


def test_api_conversation_crud(chat_client):
    created = chat_client.post("/api/chat/conversations", json={})
    assert created.status_code == 201
    cid = created.json()["id"]

    listing = chat_client.get("/api/chat/conversations").json()
    assert any(c["id"] == cid for c in listing["conversations"])

    renamed = chat_client.patch(f"/api/chat/conversations/{cid}", json={"title": "My thread"})
    assert renamed.json()["title"] == "My thread"

    assert chat_client.get(f"/api/chat/conversations/{cid}").json()["turns"] == []
    assert chat_client.get("/api/chat/conversations/999999").status_code == 404
    assert chat_client.patch("/api/chat/conversations/999999", json={"title": "x"}).status_code == 404

    assert chat_client.delete(f"/api/chat/conversations/{cid}").json()["ok"] is True
    assert chat_client.delete(f"/api/chat/conversations/{cid}").status_code == 404


def test_api_chat_turn_blocking_and_persisted(chat_client):
    cid = chat_client.post("/api/chat/conversations", json={}).json()["id"]
    turn = chat_client.post(
        f"/api/chat/conversations/{cid}/messages",
        json={"message": "What chemistry is the battery pack?"},
    ).json()
    assert turn["answered"] is True
    assert turn["rewritten"] == "What chemistry is the battery pack?"
    assert turn["result"]["citations"]
    assert turn["ask_id"] > 0  # feedback can attach to a chat turn

    detail = chat_client.get(f"/api/chat/conversations/{cid}").json()
    assert detail["n_turns"] == 1
    assert detail["title"]  # inherited from the first message

    # Unknown conversation -> 404, not a silent new thread.
    r = chat_client.post("/api/chat/conversations/999999/messages", json={"message": "hi"})
    assert r.status_code == 404


def test_api_chat_stream_multi_turn_follow_up(chat_client):
    cid = chat_client.post("/api/chat/conversations", json={}).json()["id"]
    chat_client.post(
        f"/api/chat/conversations/{cid}/messages",
        json={"message": "What chemistry is the battery pack?"},
    )

    events = []
    with chat_client.stream(
        "POST", f"/api/chat/conversations/{cid}/messages/stream",
        json={"message": "what does it depend on?"},
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

    types = [e["type"] for e in events]
    assert types[0] == "rewrite" and types[1] == "retrieval" and types[-1] == "done"
    assert "token" in types
    # The rewrite is exposed in the stream AND in the persisted turn payload.
    assert events[0]["rewritten"] != "what does it depend on?"
    assert events[-1]["turn"]["rewritten"] == events[0]["rewritten"]


def test_api_chat_refusal_turn(chat_client):
    cid = chat_client.post("/api/chat/conversations", json={}).json()["id"]
    turn = chat_client.post(
        f"/api/chat/conversations/{cid}/messages",
        json={"message": "What is the population of Japan right now?"},
    ).json()
    assert turn["answered"] is False
    assert turn["result"]["verdict"] == "insufficient"


def test_api_chat_llm_failure_maps_to_502(chat_client, monkeypatch):
    cid = chat_client.post("/api/chat/conversations", json={}).json()["id"]
    monkeypatch.setattr(app.state.engine, "llm", _DownLLM())
    r = chat_client.post(
        f"/api/chat/conversations/{cid}/messages",
        json={"message": "What chemistry is the battery pack?"},
    )
    assert r.status_code == 502
    assert "chat turn failed" in r.json()["detail"]
