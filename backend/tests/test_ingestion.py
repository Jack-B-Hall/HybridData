"""Ingestion-management jobs: background rebuild + atomic hot-swap, diff reporting,
confirm-guarded clear, single-job concurrency, and ask-during-ingest (no deadlock).
"""
from __future__ import annotations

import threading
import time

import pytest

from hde.config import Settings
from hde.engine import Engine
from hde.ingest import Record, SourceAdapter, ingest
from hde.ingestion import CLEAR_TOKEN, IngestBadRequest, IngestBusy, IngestManager


class _Corpus(SourceAdapter):
    source = "X"

    def __init__(self, records):
        self._records = records

    def records(self):
        yield from self._records


class _GatedCorpus(SourceAdapter):
    """Blocks inside records() until released, to hold a job 'running'."""

    source = "X"

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def records(self):
        self.started.set()
        self.release.wait(10)
        yield Record("A-1", "document", "Alpha", "Alpha body about widgets.", source="X")


def _v1():
    return [
        Record("A-1", "document", "Alpha", "Alpha body about widgets.", source="X"),
        Record("A-2", "document", "Beta", "Beta body about gadgets.", source="X"),
    ]


def _v2():
    # A-1 changed, A-2 removed, A-3 added.
    return [
        Record("A-1", "document", "Alpha", "Alpha body — CHANGED.", source="X"),
        Record("A-3", "document", "Gamma", "Gamma is brand new.", source="X"),
    ]


def _engine(tmp_path) -> Engine:
    s = Settings(db_path=tmp_path / "c.db", telemetry_db=tmp_path / "t.db", embedder="hash", llm_backend="mock")
    ingest(_Corpus(_v1()), s, reset=True)
    return Engine(s, shared=True)


def _wait(pred, timeout=6.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_reingest_rebuilds_and_hot_swaps(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    monkeypatch.setattr("hde.ingestion.build_adapters", lambda s: [_Corpus(_v1())])
    try:
        mgr.start("reingest")
        assert _wait(lambda: not mgr.status()["running"])
        st = mgr.status()
        assert st["status"] == "ok" and st["counts"]["records"] == 2
        # The engine now answers from the rebuilt store.
        assert eng.ask("what is alpha about").sources
    finally:
        eng.close()


def test_scan_reports_added_updated_removed(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    monkeypatch.setattr("hde.ingestion.build_adapters", lambda s: [_Corpus(_v2())])
    try:
        mgr.start("scan")
        assert _wait(lambda: not mgr.status()["running"])
        c = mgr.status()["counts"]
        assert (c["added"], c["updated"], c["removed"]) == (1, 1, 1)
    finally:
        eng.close()


def test_clear_requires_confirm_and_empties_store(tmp_path):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    try:
        with pytest.raises(IngestBadRequest):
            mgr.start("clear")  # no confirm token
        mgr.start("clear", confirm=CLEAR_TOKEN)
        assert _wait(lambda: not mgr.status()["running"])
        assert mgr.status()["status"] == "ok"
        assert eng.corpus_stats()["totals"]["artifacts"] == 0
    finally:
        eng.close()


def test_concurrent_start_is_rejected(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    gated = _GatedCorpus()
    monkeypatch.setattr("hde.ingestion.build_adapters", lambda s: [gated])
    try:
        mgr.start("reingest")
        assert gated.started.wait(3)
        with pytest.raises(IngestBusy):
            mgr.start("reingest")
        gated.release.set()
        assert _wait(lambda: not mgr.status()["running"])
    finally:
        gated.release.set()
        eng.close()


def test_ask_during_ingest_does_not_deadlock(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    gated = _GatedCorpus()
    monkeypatch.setattr("hde.ingestion.build_adapters", lambda s: [gated])
    try:
        mgr.start("reingest")
        assert gated.started.wait(3)  # job is mid-build; old store still serving
        box: dict = {}
        t = threading.Thread(target=lambda: box.setdefault("r", eng.ask("what is alpha about")), daemon=True)
        t.start()
        t.join(5)
        assert not t.is_alive(), "ask hung while an ingest job was running"
        assert box.get("r") is not None
        gated.release.set()
        assert _wait(lambda: not mgr.status()["running"])
    finally:
        gated.release.set()
        eng.close()


def test_job_history_persists_in_telemetry(tmp_path, monkeypatch):
    eng = _engine(tmp_path)
    mgr = IngestManager(eng)
    monkeypatch.setattr("hde.ingestion.build_adapters", lambda s: [_Corpus(_v1())])
    try:
        mgr.start("reingest")
        assert _wait(lambda: not mgr.status()["running"])
        jobs = mgr.history()
        assert jobs and jobs[0]["action"] == "reingest" and jobs[0]["status"] == "ok"
        assert jobs[0]["duration_ms"] is not None and jobs[0]["finished_at"]
    finally:
        eng.close()
