"""Golden-set store (CRUD + seed + golden_answer), the two scoring axes
(deterministic retrieval sub-score + LLM-as-judge), the composite formula, and the
background runner: end-to-end, concurrency, and graceful backend/judge-down.
"""
from __future__ import annotations

import threading
import time
import types

import pytest

from hde.config import Settings
from hde.engine import Engine
from hde.ingest import Record, SourceAdapter, ingest
from hde.judge import JudgeUnavailable, MockJudge, parse_judge_json
from hde.testing import (
    TestBusy, TestManager, Weights, composite_score, load_seed_questions,
    retrieval_score,
)


class _Corpus(SourceAdapter):
    source = "X"

    def __init__(self, records):
        self._records = records

    def records(self):
        yield from self._records


def _corpus():
    return [
        Record("A-1", "document", "Alpha", "Alpha body about widgets and things.", source="X"),
        Record("A-2", "document", "Beta", "Beta body about gadgets and things.", source="X"),
    ]


def _engine(tmp_path, **overrides) -> Engine:
    s = Settings(db_path=tmp_path / "c.db", telemetry_db=tmp_path / "t.db",
                 embedder="hash", llm_backend="mock", **overrides)
    ingest(_Corpus(_corpus()), s, reset=True)
    return Engine(s, shared=True)


def _wait(pred, timeout=6.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _res(answered, *, citations=None, answer="", verdict="sufficient", latency_ms=5, sources=None):
    return types.SimpleNamespace(
        answered=answered, citations=citations or [], answer=answer,
        verdict=verdict, latency_ms=latency_ms, sources=sources or [],
    )


# ── retrieval sub-score ───────────────────────────────────────────────────────
def test_retrieval_score_full_when_all_citations_present():
    q = {"behaviour": "answer", "citations": ["A-1"], "keywords": ["alpha"]}
    score, failed = retrieval_score(q, _res(True, citations=[{"artifact_id": "A-1"}], answer="about alpha"))
    assert score == 1.0 and failed == []


def test_retrieval_score_partial_citation_recall():
    q = {"behaviour": "answer", "citations": ["A-1", "A-9"], "keywords": []}
    score, failed = retrieval_score(q, _res(True, citations=[{"artifact_id": "A-1"}]))
    assert score == 0.5 and any("A-9" in f for f in failed)


def test_retrieval_score_zero_on_wrong_behaviour():
    q = {"behaviour": "answer", "citations": [], "keywords": []}
    assert retrieval_score(q, _res(False))[0] == 0.0
    q2 = {"behaviour": "refuse", "citations": [], "keywords": []}
    assert retrieval_score(q2, _res(True))[0] == 0.0
    assert retrieval_score(q2, _res(False))[0] == 1.0


# ── composite formula ─────────────────────────────────────────────────────────
def test_composite_blends_retrieval_and_judge_with_weights():
    w = Weights(retrieval=0.30, correctness=0.40, groundedness=0.20, completeness=0.10)
    dims = {"correctness": 1.0, "groundedness": 0.5, "completeness": 0.0, "citation_quality": 1.0}
    # 100 * (0.30*1 + 0.40*1 + 0.20*0.5 + 0.10*0) = 100 * 0.80 = 80.0
    assert composite_score(1.0, dims, w) == 80.0


def test_composite_degrades_to_retrieval_without_judge():
    w = Weights()
    assert composite_score(0.5, None, w) == 50.0
    assert composite_score(1.0, None, w) == 100.0


def test_composite_weights_are_normalised():
    # Weights that don't sum to 1 are normalised, so the score stays 0-100.
    w = Weights(retrieval=3, correctness=4, groundedness=2, completeness=1)
    dims = {"correctness": 1.0, "groundedness": 1.0, "completeness": 1.0, "citation_quality": 1.0}
    assert composite_score(1.0, dims, w) == 100.0


# ── judge ─────────────────────────────────────────────────────────────────────
def test_parse_judge_json_tolerates_fences_and_clamps():
    raw = 'ignore me ```json\n{"correctness": 1.5, "groundedness": 0.4, ' \
          '"completeness": -1, "citation_quality": 0.9, "justification": "ok"}\n``` trailing'
    out = parse_judge_json(raw)
    assert out["correctness"] == 1.0 and out["completeness"] == 0.0
    assert out["groundedness"] == 0.4 and out["justification"] == "ok"


def test_parse_judge_json_raises_without_json():
    with pytest.raises(ValueError):
        parse_judge_json("the answer looks great, 9 out of 10")


def test_mock_judge_is_deterministic_and_bounded():
    j = MockJudge()
    a = j.judge(question="q", golden="alpha widgets chemistry", answer="alpha widgets [1]",
                evidence=["alpha widgets chemistry body"])
    b = j.judge(question="q", golden="alpha widgets chemistry", answer="alpha widgets [1]",
                evidence=["alpha widgets chemistry body"])
    assert a == b
    for dim in ("correctness", "groundedness", "completeness", "citation_quality"):
        assert 0.0 <= a[dim] <= 1.0


# ── golden-set store (incl. golden_answer) ────────────────────────────────────
def test_golden_crud_with_golden_answer(tmp_path):
    eng = _engine(tmp_path)
    tel = eng.telemetry
    try:
        qid = tel.add_golden({"text": "Q1?", "category": "lookup", "behaviour": "answer",
                              "citations": ["A-1"], "keywords": ["alpha"],
                              "golden_answer": "Alpha is about widgets.", "enabled": True})
        got = tel.get_golden(qid)
        assert got["golden_answer"] == "Alpha is about widgets." and got["citations"] == ["A-1"]

        assert tel.update_golden(qid, {"golden_answer": "Updated reference."})
        assert tel.get_golden(qid)["golden_answer"] == "Updated reference."

        assert len(tel.list_golden(category="lookup")) == 1
        assert tel.delete_golden(qid) and tel.get_golden(qid) is None
    finally:
        eng.close()


def test_seed_carries_golden_answers_for_answer_questions():
    seed = load_seed_questions()
    assert seed, "expected the bundled demo gold set to load"
    answers = [q for q in seed if q["behaviour"] == "answer"]
    assert answers and all(q.get("golden_answer") for q in answers)
    negatives = [q for q in seed if q["behaviour"] == "refuse"]
    assert negatives and all(q.get("golden_answer") is None for q in negatives)


# ── the background runner ─────────────────────────────────────────────────────
def test_run_scores_composite_and_persists(tmp_path):
    eng = _engine(tmp_path)  # mock answerer + (default) mock judge
    mgr = TestManager(eng)
    try:
        eng.telemetry.add_golden({"text": "what is alpha about", "category": "lookup",
                                  "behaviour": "answer",
                                  "golden_answer": "Alpha is about widgets.", "enabled": True})
        eng.telemetry.add_golden({"text": "airspeed of an unladen swallow",
                                  "category": "negative", "behaviour": "refuse", "enabled": True})
        mgr.start()
        assert _wait(lambda: not mgr.status()["running"])
        assert mgr.status()["status"] == "ok"

        run = mgr.history()[0]
        assert run["mean_composite"] is not None
        assert run["judge_backend"] == "mock/mock"  # the answer question got judged
        detail = mgr.run_detail(run["id"])
        by_beh = {r["behaviour"]: r for r in detail["results"]}
        ans = by_beh["answer"]
        assert ans["judged"] is True and ans["composite"] is not None
        assert ans["retrieval_score"] is not None
        assert ans["judge_correctness"] is not None and ans["judge_justification"]
        # The refuse question is scored deterministically (no judge, no golden).
        assert by_beh["refuse"]["judged"] is False
    finally:
        eng.close()


def test_answer_without_golden_degrades_to_deterministic(tmp_path):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)
    try:
        eng.telemetry.add_golden({"text": "what is alpha about", "category": "lookup",
                                  "behaviour": "answer", "enabled": True})  # no golden_answer
        mgr.start()
        assert _wait(lambda: not mgr.status()["running"])
        detail = mgr.run_detail(mgr.history()[0]["id"])
        r = detail["results"][0]
        assert r["judged"] is False and r["composite"] is not None
        # composite == 100 * retrieval_score when not judged
        assert abs(r["composite"] - 100.0 * r["retrieval_score"]) < 0.05
    finally:
        eng.close()


def test_run_respects_category_subset(tmp_path):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)
    try:
        eng.telemetry.add_golden({"text": "q lookup", "category": "lookup", "enabled": True})
        eng.telemetry.add_golden({"text": "q impact", "category": "impact", "enabled": True})
        mgr.start(categories=["lookup"])
        assert _wait(lambda: not mgr.status()["running"])
        assert mgr.status()["total"] == 1
        assert "lookup" in mgr.history()[0]["scope"]
    finally:
        eng.close()


def test_concurrent_run_is_rejected(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)
    gate = threading.Event()
    started = threading.Event()
    real_ask = eng.ask

    def _slow_ask(question):
        started.set()
        gate.wait(10)
        return real_ask(question)

    monkeypatch.setattr(eng, "ask", _slow_ask)
    try:
        eng.telemetry.add_golden({"text": "q1", "category": "lookup", "enabled": True})
        mgr.start()
        assert started.wait(3)
        with pytest.raises(TestBusy):
            mgr.start()
        gate.set()
        assert _wait(lambda: not mgr.status()["running"])
    finally:
        gate.set()
        eng.close()


def test_run_errors_cleanly_when_answer_backend_down(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)

    def _down(question):
        raise RuntimeError("<urlopen error [Errno 113] No route to host>")

    monkeypatch.setattr(eng, "ask", _down)
    try:
        eng.telemetry.add_golden({"text": "q1", "category": "lookup", "enabled": True})
        mgr.start()
        assert _wait(lambda: not mgr.status()["running"])
        st = mgr.status()
        assert st["status"] == "error" and "unreachable" in (st["error"] or "")
    finally:
        eng.close()


def test_run_errors_cleanly_when_judge_down(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)

    class _DownJudge:
        name = "ollama/judge"

        def judge(self, **kw):
            raise JudgeUnavailable("<urlopen error [Errno 113] No route to host>")

    monkeypatch.setattr("hde.testing.build_judge", lambda s: _DownJudge())
    try:
        eng.telemetry.add_golden({"text": "what is alpha about", "category": "lookup",
                                  "behaviour": "answer",
                                  "golden_answer": "Alpha is about widgets.", "enabled": True})
        mgr.start()
        assert _wait(lambda: not mgr.status()["running"])
        st = mgr.status()
        assert st["status"] == "error" and "judge backend unreachable" in (st["error"] or "")
    finally:
        eng.close()
