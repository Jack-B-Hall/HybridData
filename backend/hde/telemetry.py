"""Request telemetry + user feedback in a separate, writable SQLite database.

This is deliberately isolated from the corpus store (``hde.db``): that store is
read-only at serve time and part of the protected core, so nothing here ever
writes to it. Telemetry is best-effort — every write is guarded so a telemetry
failure can never break an answer — and it powers the Data Explorer's "System
health" view.

Two tables:

* ``asks``      one row per question (blocking or streamed), with a timing
                breakdown and a terminal ``status`` (ok / error / abandoned).
* ``feedback``  thumbs up/down (+ optional comment) tied to an ``asks`` row.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS asks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL,
  question      TEXT    NOT NULL,
  verdict       TEXT,
  confidence    TEXT,
  answered      INTEGER,
  backend       TEXT,
  latency_ms    INTEGER,
  retrieval_ms  INTEGER,
  llm_ms        INTEGER,
  n_sources     INTEGER,
  n_graph_paths INTEGER,
  answer_chars  INTEGER,
  streamed      INTEGER,
  status        TEXT    NOT NULL DEFAULT 'ok',   -- 'ok' | 'error' | 'abandoned'
  error         TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ask_id  INTEGER NOT NULL,
  ts      TEXT    NOT NULL,
  rating  TEXT    NOT NULL,                       -- 'up' | 'down'
  comment TEXT,
  FOREIGN KEY (ask_id) REFERENCES asks(id)
);
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  action      TEXT    NOT NULL,                     -- 'reingest' | 'scan' | 'clear'
  source      TEXT,
  status      TEXT    NOT NULL,                     -- 'ok' | 'error'
  n_records   INTEGER, n_chunks INTEGER, n_nodes INTEGER, n_edges INTEGER,
  n_added     INTEGER, n_updated INTEGER, n_removed INTEGER,
  duration_ms INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_asks_ts ON asks(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_ask ON feedback(ask_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _percentile(values: list[int], p: float) -> int:
    """Linear-interpolated percentile (p in 0..1) of a list of ints."""
    if not values:
        return 0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return int(round(s[lo] + (s[hi] - s[lo]) * (k - lo)))


class Telemetry:
    """A thread-safe telemetry writer/reader over its own SQLite connection."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # One connection shared across the request threadpool, guarded by a lock
        # (the corpus engine uses the same pattern). WAL keeps writes cheap.
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(_SCHEMA)
        self.conn.commit()
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    # ── writes ───────────────────────────────────────────────────────────────
    def log_ask(
        self, *, question: str, verdict: str | None, confidence: str | None,
        answered: bool, backend: str, latency_ms: int, retrieval_ms: int,
        llm_ms: int, n_sources: int, n_graph_paths: int, answer_chars: int,
        streamed: bool, status: str = "ok", error: str | None = None,
    ) -> int | None:
        """Insert one ask row; returns its id (or None if telemetry is failing)."""
        try:
            with self._lock:
                cur = self.conn.execute(
                    "INSERT INTO asks (ts, question, verdict, confidence, answered, "
                    "backend, latency_ms, retrieval_ms, llm_ms, n_sources, n_graph_paths, "
                    "answer_chars, streamed, status, error) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (_now(), question, verdict, confidence, int(answered), backend,
                     latency_ms, retrieval_ms, llm_ms, n_sources, n_graph_paths,
                     answer_chars, int(streamed), status, error),
                )
                self.conn.commit()
                return int(cur.lastrowid)
        except sqlite3.Error:
            return None

    def add_feedback(self, ask_id: int, rating: str, comment: str | None = None) -> int | None:
        """Record thumbs feedback for a known ask. Returns None if the ask is unknown."""
        with self._lock:
            exists = self.conn.execute("SELECT 1 FROM asks WHERE id = ?", (ask_id,)).fetchone()
            if not exists:
                return None
            cur = self.conn.execute(
                "INSERT INTO feedback (ask_id, ts, rating, comment) VALUES (?,?,?,?)",
                (ask_id, _now(), rating, comment),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def log_ingest_job(self, job: dict) -> int | None:
        """Persist one ingest-management run. Lives in telemetry (not the corpus
        store), so the history survives corpus rebuilds/clears."""
        cols = (
            "started_at", "finished_at", "action", "source", "status", "n_records",
            "n_chunks", "n_nodes", "n_edges", "n_added", "n_updated", "n_removed",
            "duration_ms", "error",
        )
        try:
            with self._lock:
                cur = self.conn.execute(
                    f"INSERT INTO ingest_jobs ({', '.join(cols)}) "
                    f"VALUES ({', '.join('?' * len(cols))})",
                    tuple(job.get(c) for c in cols),
                )
                self.conn.commit()
                return int(cur.lastrowid)
        except sqlite3.Error:
            return None

    def ingest_jobs(self, limit: int = 25) -> list[dict]:
        cols = (
            "id", "started_at", "finished_at", "action", "source", "status",
            "n_records", "n_chunks", "n_nodes", "n_edges", "n_added", "n_updated",
            "n_removed", "duration_ms", "error",
        )
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(cols)} FROM ingest_jobs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    # ── reads ────────────────────────────────────────────────────────────────
    def health(self, recent_limit: int = 25) -> dict:
        """Aggregate system-health metrics + a recent-questions slice."""
        with self._lock:
            c = self.conn
            total = c.execute("SELECT COUNT(*) FROM asks").fetchone()[0]
            answered = c.execute(
                "SELECT COUNT(*) FROM asks WHERE status='ok' AND answered=1").fetchone()[0]
            refused = c.execute(
                "SELECT COUNT(*) FROM asks WHERE status='ok' AND answered=0").fetchone()[0]
            errors = c.execute("SELECT COUNT(*) FROM asks WHERE status='error'").fetchone()[0]
            abandoned = c.execute("SELECT COUNT(*) FROM asks WHERE status='abandoned'").fetchone()[0]

            latencies = [
                r[0] for r in c.execute(
                    "SELECT latency_ms FROM asks WHERE status='ok' AND latency_ms IS NOT NULL")
            ]
            up = c.execute("SELECT COUNT(*) FROM feedback WHERE rating='up'").fetchone()[0]
            down = c.execute("SELECT COUNT(*) FROM feedback WHERE rating='down'").fetchone()[0]

            per_day = [
                {"day": r[0], "count": r[1]}
                for r in c.execute(
                    "SELECT substr(ts,1,10) AS day, COUNT(*) FROM asks "
                    "GROUP BY day ORDER BY day DESC LIMIT 14")
            ]
            recent = [
                {
                    "id": r[0], "ts": r[1], "question": r[2], "verdict": r[3],
                    "confidence": r[4], "answered": bool(r[5]), "latency_ms": r[6],
                    "status": r[7], "streamed": bool(r[8]), "feedback": r[9],
                }
                for r in c.execute(
                    "SELECT a.id, a.ts, a.question, a.verdict, a.confidence, a.answered, "
                    "a.latency_ms, a.status, a.streamed, "
                    "(SELECT rating FROM feedback f WHERE f.ask_id = a.id ORDER BY f.id DESC LIMIT 1) "
                    "FROM asks a ORDER BY a.id DESC LIMIT ?",
                    (recent_limit,),
                )
            ]

        answerable_total = answered + refused
        return {
            "totals": {
                "asks": total, "answered": answered, "refused": refused,
                "errors": errors, "abandoned": abandoned,
            },
            "answer_rate": (answered / answerable_total) if answerable_total else 0.0,
            "latency": {"p50_ms": _percentile(latencies, 0.5), "p95_ms": _percentile(latencies, 0.95)},
            "feedback": {"up": up, "down": down, "ratio": (up / (up + down)) if (up + down) else 0.0},
            "per_day": list(reversed(per_day)),
            "recent": recent,
        }
