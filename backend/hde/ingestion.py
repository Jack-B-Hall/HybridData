"""Ingestion management: run corpus rebuilds as a background job and hot-swap the
serving store when they finish.

Design (mirrors the deadlock-safe pattern used for asks):

* One job at a time — :meth:`IngestManager.start` rejects a concurrent start.
* The slow work (ingest) runs in a background thread into a **temp** database, so
  the engine keeps answering from the current store the whole time.
* On success the engine does a fast, atomic file swap under its lock
  (:meth:`hde.engine.Engine.swap_store`); in-flight streams use already-materialised
  data and are unaffected.
* Every run is logged to the telemetry DB (not the corpus store), so the history
  survives clears/rebuilds.
"""
from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from . import store
from .ingest import build_adapters, ingest
from .ingest.runner import _collect

CLEAR_TOKEN = "CLEAR"
ACTIONS = ("reingest", "scan", "clear")


class IngestBusy(Exception):
    """A job is already running."""


class IngestBadRequest(Exception):
    """Unknown action, or a clear without the confirm token."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _source_label(settings) -> str:
    return ", ".join(kind if not path else f"{kind}:{path}" for kind, path in settings.ingest_sources)


def _rec_hash(title, text, source, subsystem) -> str:
    payload = "\x00".join(str(x or "") for x in (title, text, source, subsystem))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


@dataclass
class JobStatus:
    running: bool = False
    action: str | None = None
    stage: str = "idle"
    started_at: str | None = None
    finished_at: str | None = None
    status: str | None = None  # 'ok' | 'error' once finished
    error: str | None = None
    counts: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


class IngestManager:
    """Serialises ingest jobs and hot-swaps the engine's store on completion."""

    def __init__(self, engine) -> None:
        self.engine = engine
        self._lock = threading.Lock()
        self._status = JobStatus()
        self._thread: threading.Thread | None = None

    # ── queries ──────────────────────────────────────────────────────────────
    def status(self) -> dict:
        with self._lock:
            return self._status.as_dict()

    def history(self, limit: int = 25) -> list[dict]:
        return self.engine.telemetry.ingest_jobs(limit)

    # ── control ──────────────────────────────────────────────────────────────
    def start(self, action: str, confirm: str | None = None) -> dict:
        if action not in ACTIONS:
            raise IngestBadRequest(f"unknown action {action!r} (use {', '.join(ACTIONS)})")
        if action == "clear" and confirm != CLEAR_TOKEN:
            raise IngestBadRequest("clear requires the confirm token")
        with self._lock:
            if self._status.running:
                raise IngestBusy("an ingest job is already running")
            self._status = JobStatus(running=True, action=action, stage="starting", started_at=_now())
        self._thread = threading.Thread(target=self._run, args=(action,), daemon=True)
        self._thread.start()
        return self.status()

    def _set(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    def _run(self, action: str) -> None:
        t0 = time.time()
        settings = self.engine.settings
        job: dict = {"started_at": self._status.started_at, "action": action, "source": _source_label(settings)}
        try:
            counts = self._do_clear(settings) if action == "clear" else self._do_rebuild(settings, action)
            self._set(running=False, stage="done", status="ok", finished_at=_now(), counts=counts)
            job.update(status="ok", **_job_counts(counts))
        except Exception as exc:  # surface as job status, never crash the server
            self._set(running=False, stage="error", status="error", error=str(exc), finished_at=_now())
            job.update(status="error", error=str(exc))
        job["finished_at"] = _now()
        job["duration_ms"] = int((time.time() - t0) * 1000)
        self.engine.telemetry.log_ingest_job(job)

    # ── actions ──────────────────────────────────────────────────────────────
    def _temp_db(self, settings) -> Path:
        p = Path(settings.db_path)
        return p.with_name(p.name + f".build-{int(time.time() * 1000)}")

    def _do_clear(self, settings) -> dict:
        self._set(stage="clearing")
        tmp = self._temp_db(settings)
        try:
            conn = store.connect(tmp, create=True)
            store.initialise(conn, self.engine.embedder.dim)
            store.set_meta(conn, "embedder", settings.embedder)
            store.set_meta(conn, "snapshot_at", _now())
            store.set_meta(conn, "id_pattern", settings.id_pattern)
            conn.close()
            self._set(stage="swapping")
            self.engine.swap_store(tmp)
        finally:
            _cleanup(tmp)
        return {"records": 0, "chunks": 0, "nodes": 0, "edges": 0, "added": 0, "updated": 0, "removed": 0}

    def _do_rebuild(self, settings, action: str) -> dict:
        adapters = build_adapters(settings)
        if not adapters:
            raise IngestBadRequest("no ingest sources configured (see [ingest] in hde.toml)")

        added = updated = removed = None
        if action == "scan":
            self._set(stage="scanning source")
            added, updated, removed = self._diff(settings, adapters)

        self._set(stage="ingesting")
        tmp = self._temp_db(settings)
        try:
            result = ingest(
                adapters, replace(settings, db_path=tmp), reset=True,
                embedder=self.engine.embedder, progress=lambda m: self._set(stage=m),
            )
            self._set(stage="swapping")
            self.engine.swap_store(tmp)
        finally:
            _cleanup(tmp)
        return {
            "records": result.n_records, "chunks": result.n_chunks,
            "nodes": result.n_nodes, "edges": result.n_edges,
            "added": added, "updated": updated, "removed": removed,
        }

    def _diff(self, settings, adapters) -> tuple[int, int, int]:
        """Added / updated / removed vs the current store, by content hash."""
        new = {r.id: _rec_hash(r.title, r.text, r.source, r.subsystem) for r in _collect(adapters)}
        old: dict[str, str] = {}
        conn = store.connect(settings.db_path)  # independent read of the live store
        try:
            for row in conn.execute("SELECT id, title, text, source, subsystem FROM artifacts"):
                old[row[0]] = _rec_hash(row[1], row[2], row[3], row[4])
        finally:
            conn.close()
        added = sum(1 for i in new if i not in old)
        removed = sum(1 for i in old if i not in new)
        updated = sum(1 for i in new if i in old and new[i] != old[i])
        return added, updated, removed


def _cleanup(tmp: Path) -> None:
    """Remove a temp build DB if the swap didn't consume it (e.g. on error)."""
    for p in (tmp, tmp.with_name(tmp.name + "-wal"), tmp.with_name(tmp.name + "-shm")):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def _job_counts(counts: dict) -> dict:
    return {
        "n_records": counts.get("records"), "n_chunks": counts.get("chunks"),
        "n_nodes": counts.get("nodes"), "n_edges": counts.get("edges"),
        "n_added": counts.get("added"), "n_updated": counts.get("updated"),
        "n_removed": counts.get("removed"),
    }
