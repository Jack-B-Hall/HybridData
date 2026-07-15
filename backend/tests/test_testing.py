"""Golden-set store (CRUD + seed), deterministic grading, and the background test
runner: end-to-end run, single-run concurrency, and graceful backend-down handling.
"""
from __future__ import annotations

import threading
import time
import types

import pytest

from hde.config import Settings
from hde.engine import Engine
from hde.ingest import Record, SourceAdapter, ingest
from hde.testing import TestBusy, TestManager, grade, load_seed_questions


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


def _engine(tmp_path) -> Engine:
    s = Settings(db_path=tmp_path / "c.db", telemetry_db=tmp_path / "t.db",
                 embedder="hash", llm_backend="mock")
    ingest(_Corpus(_corpus()), s, reset=True)
    return Engine(s, shared=True)


def _wait(pred, timeout=6.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _res(answered, *, citations=None, answer="", verdict="sufficient", latency_ms=5):
    return types.SimpleNamespace(
        answered=answered, citations=citations or [], answer=answer,
        verdict=verdict, latency_ms=latency_ms,
    )


# ── grading ────────────────────────────────────────────────────────────────
def test_grade_answer_with_expected_citations_passes():
    q = {"behaviour": "answer", "citations": ["A-1"], "keywords": []}
    ok, failed = grade(q, _res(True, citations=[{"artifact_id": "A-1"}]))
    assert ok and failed == []


def test_grade_answer_missing_citation_fails():
    q = {"behaviour": "answer", "citations": ["A-1", "A-9"], "keywords": []}
    ok, failed = grade(q, _res(True, citations=[{"artifact_id": "A-1"}]))
    assert not ok and any("A-9" in f for f in failed)


def test_grade_answer_missing_keyword_fails():
    q = {"behaviour": "answer", "citations": [], "keywords": ["widgets"]}
    ok, failed = grade(q, _res(True, answer="this is about gadgets"))
    assert not ok and any("keyword" in f for f in failed)


def test_grade_expected_answer_but_refused_fails():
    q = {"behaviour": "answer", "citations": [], "keywords": []}
    ok, failed = grade(q, _res(False))
    assert not ok and any("expected an answer" in f for f in failed)


def test_grade_refuse_correct_passes_and_wrong_fails():
    q = {"behaviour": "refuse", "citations": [], "keywords": []}
    assert grade(q, _res(False))[0] is True
    ok, failed = grade(q, _res(True))
    assert not ok and any("refusal" in f for f in failed)


# ── golden-set store ─────────────────────────────────────────────────────────
def test_golden_crud_and_filters(tmp_path):
    eng = _engine(tmp_path)
    tel = eng.telemetry
    try:
        qid = tel.add_golden({"text": "Q1?", "category": "lookup", "behaviour": "answer",
                              "citations": ["A-1"], "keywords": ["alpha"], "enabled": True})
        tel.add_golden({"text": "Off scope?", "category": "negative", "behaviour": "refuse",
                        "enabled": False})
        got = tel.get_golden(qid)
        assert got["citations"] == ["A-1"] and got["keywords"] == ["alpha"] and got["enabled"] is True

        assert len(tel.list_golden(category="lookup")) == 1
        assert len(tel.list_golden(behaviour="refuse")) == 1
        assert len(tel.list_golden(enabled=True)) == 1  # the disabled one is excluded

        assert tel.update_golden(qid, {"enabled": False, "keywords": ["alpha", "widgets"]})
        upd = tel.get_golden(qid)
        assert upd["enabled"] is False and upd["keywords"] == ["alpha", "widgets"]

        assert tel.delete_golden(qid)
        assert tel.get_golden(qid) is None
        assert tel.update_golden(9999, {"text": "x"}) is False
    finally:
        eng.close()


def test_seed_only_when_empty(tmp_path):
    eng = _engine(tmp_path)
    tel = eng.telemetry
    try:
        seed = [{"text": "seeded?", "category": "lookup"}]
        assert tel.seed_golden(seed) == 1
        assert tel.seed_golden(seed) == 0  # already populated -> no-op
        assert tel.golden_count() == 1
    finally:
        eng.close()


def test_load_seed_questions_maps_negatives_to_refuse():
    seed = load_seed_questions()
    # The bundled gold file is present in a source checkout.
    assert seed, "expected the bundled demo gold set to load"
    negatives = [q for q in seed if q["category"] == "negative"]
    assert negatives and all(q["behaviour"] == "refuse" for q in negatives)
    answers = [q for q in seed if q["category"] != "negative"]
    assert all(q["behaviour"] == "answer" for q in answers)


# ── the background runner ────────────────────────────────────────────────────
def test_run_grades_and_persists(tmp_path):
    eng = _engine(tmp_path)
    mgr = TestManager(eng)
    try:
        eng.telemetry.add_golden({"text": "what is alpha about", "category": "lookup",
                                  "behaviour": "answer", "enabled": True})
        eng.telemetry.add_golden({"text": "what is the airspeed of an unladen swallow",
                                  "category": "negative", "behaviour": "refuse", "enabled": True})
        mgr.start()
        assert _wait(lambda: not mgr.status()["running"])
        st = mgr.status()
        assert st["status"] == "ok" and st["total"] == 2
        assert st["passed"] + st["failed"] == 2

        runs = mgr.history()
        assert runs and runs[0]["status"] == "ok" and runs[0]["total"] == 2
        detail = mgr.run_detail(runs[0]["id"])
        assert len(detail["results"]) == 2
        assert all("passed" in r and "failed_checks" in r for r in detail["results"])
        assert detail["mean_latency_ms"] is not None
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


def test_run_errors_cleanly_when_backend_down(tmp_path, monkeypatch):
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
        assert mgr.history()[0]["status"] == "error"
    finally:
        eng.close()
