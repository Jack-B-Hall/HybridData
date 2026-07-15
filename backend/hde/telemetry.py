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

import json
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
CREATE TABLE IF NOT EXISTS golden_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'general',
  behaviour  TEXT    NOT NULL DEFAULT 'answer',      -- 'answer' | 'refuse'
  citations  TEXT,                                   -- JSON list of expected artifact ids
  keywords   TEXT,                                   -- JSON list of expected keywords/phrases
  enabled    INTEGER NOT NULL DEFAULT 1,
  notes      TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS test_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  status          TEXT    NOT NULL,                  -- 'ok' | 'error'
  backend         TEXT,
  scope           TEXT,                              -- which questions ran, e.g. 'all enabled'
  total           INTEGER, passed INTEGER, failed INTEGER,
  answer_rate     REAL,                              -- correct-answer rate on ANSWER questions
  refusal_rate    REAL,                              -- correct-refusal rate on REFUSE questions
  mean_latency_ms INTEGER,
  duration_ms     INTEGER,
  error           TEXT
);
CREATE TABLE IF NOT EXISTS test_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  question_id   INTEGER,
  question      TEXT,
  category      TEXT,
  behaviour     TEXT,
  answered      INTEGER,
  verdict       TEXT,
  passed        INTEGER,
  failed_checks TEXT,                                -- JSON list of failure reasons
  latency_ms    INTEGER,
  error         TEXT,
  FOREIGN KEY (run_id) REFERENCES test_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_asks_ts ON asks(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_ask ON feedback(ask_id);
CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
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

    # ── golden-set questions (writable, survives corpus clears) ───────────────
    _GOLDEN_COLS = (
        "id", "text", "category", "behaviour", "citations", "keywords",
        "enabled", "notes", "created_at", "updated_at",
    )

    @staticmethod
    def _golden_row(r) -> dict:
        d = dict(zip(Telemetry._GOLDEN_COLS, r))
        d["citations"] = json.loads(d["citations"]) if d["citations"] else []
        d["keywords"] = json.loads(d["keywords"]) if d["keywords"] else []
        d["enabled"] = bool(d["enabled"])
        return d

    def golden_count(self) -> int:
        with self._lock:
            return self.conn.execute("SELECT COUNT(*) FROM golden_questions").fetchone()[0]

    def seed_golden(self, questions: list[dict]) -> int:
        """Insert seed questions only when the table is empty. Returns rows added."""
        with self._lock:
            if self.conn.execute("SELECT COUNT(*) FROM golden_questions").fetchone()[0]:
                return 0
            now = _now()
            n = 0
            for q in questions:
                self.conn.execute(
                    "INSERT INTO golden_questions (text, category, behaviour, citations, "
                    "keywords, enabled, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (q["text"], q.get("category", "general"), q.get("behaviour", "answer"),
                     json.dumps(q.get("citations", [])), json.dumps(q.get("keywords", [])),
                     int(q.get("enabled", True)), q.get("notes"), now, now),
                )
                n += 1
            self.conn.commit()
            return n

    def list_golden(self, *, category: str | None = None, behaviour: str | None = None,
                    enabled: bool | None = None) -> list[dict]:
        clauses, params = [], []
        if category:
            clauses.append("category = ?"); params.append(category)
        if behaviour:
            clauses.append("behaviour = ?"); params.append(behaviour)
        if enabled is not None:
            clauses.append("enabled = ?"); params.append(int(enabled))
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(self._GOLDEN_COLS)} FROM golden_questions{where} "
                "ORDER BY category, id", params,
            ).fetchall()
        return [self._golden_row(r) for r in rows]

    def get_golden(self, qid: int) -> dict | None:
        with self._lock:
            r = self.conn.execute(
                f"SELECT {', '.join(self._GOLDEN_COLS)} FROM golden_questions WHERE id = ?",
                (qid,),
            ).fetchone()
        return self._golden_row(r) if r else None

    def add_golden(self, q: dict) -> int:
        now = _now()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO golden_questions (text, category, behaviour, citations, "
                "keywords, enabled, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (q["text"], q.get("category", "general"), q.get("behaviour", "answer"),
                 json.dumps(q.get("citations", [])), json.dumps(q.get("keywords", [])),
                 int(q.get("enabled", True)), q.get("notes"), now, now),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def update_golden(self, qid: int, fields: dict) -> bool:
        allowed = {"text", "category", "behaviour", "citations", "keywords", "enabled", "notes"}
        sets, params = [], []
        for k, v in fields.items():
            if k not in allowed:
                continue
            if k in ("citations", "keywords"):
                v = json.dumps(v or [])
            elif k == "enabled":
                v = int(bool(v))
            sets.append(f"{k} = ?"); params.append(v)
        if not sets:
            return self.get_golden(qid) is not None
        sets.append("updated_at = ?"); params.append(_now())
        params.append(qid)
        with self._lock:
            cur = self.conn.execute(
                f"UPDATE golden_questions SET {', '.join(sets)} WHERE id = ?", params)
            self.conn.commit()
            return cur.rowcount > 0

    def delete_golden(self, qid: int) -> bool:
        with self._lock:
            cur = self.conn.execute("DELETE FROM golden_questions WHERE id = ?", (qid,))
            self.conn.commit()
            return cur.rowcount > 0

    # ── test runs (writable, survives corpus clears) ──────────────────────────
    def log_test_run(self, run: dict, results: list[dict]) -> int | None:
        run_cols = (
            "started_at", "finished_at", "status", "backend", "scope", "total",
            "passed", "failed", "answer_rate", "refusal_rate", "mean_latency_ms",
            "duration_ms", "error",
        )
        res_cols = (
            "question_id", "question", "category", "behaviour", "answered", "verdict",
            "passed", "failed_checks", "latency_ms", "error",
        )
        try:
            with self._lock:
                cur = self.conn.execute(
                    f"INSERT INTO test_runs ({', '.join(run_cols)}) "
                    f"VALUES ({', '.join('?' * len(run_cols))})",
                    tuple(run.get(c) for c in run_cols),
                )
                run_id = int(cur.lastrowid)
                for res in results:
                    row = dict(res)
                    row["failed_checks"] = json.dumps(res.get("failed_checks") or [])
                    self.conn.execute(
                        f"INSERT INTO test_results (run_id, {', '.join(res_cols)}) "
                        f"VALUES (?, {', '.join('?' * len(res_cols))})",
                        (run_id, *(row.get(c) for c in res_cols)),
                    )
                self.conn.commit()
                return run_id
        except sqlite3.Error:
            return None

    def test_runs(self, limit: int = 25) -> list[dict]:
        cols = (
            "id", "started_at", "finished_at", "status", "backend", "scope", "total",
            "passed", "failed", "answer_rate", "refusal_rate", "mean_latency_ms",
            "duration_ms", "error",
        )
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(cols)} FROM test_runs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    def test_run(self, run_id: int) -> dict | None:
        run_cols = (
            "id", "started_at", "finished_at", "status", "backend", "scope", "total",
            "passed", "failed", "answer_rate", "refusal_rate", "mean_latency_ms",
            "duration_ms", "error",
        )
        res_cols = (
            "id", "question_id", "question", "category", "behaviour", "answered",
            "verdict", "passed", "failed_checks", "latency_ms", "error",
        )
        with self._lock:
            r = self.conn.execute(
                f"SELECT {', '.join(run_cols)} FROM test_runs WHERE id = ?", (run_id,),
            ).fetchone()
            if not r:
                return None
            run = dict(zip(run_cols, r))
            rows = self.conn.execute(
                f"SELECT {', '.join(res_cols)} FROM test_results WHERE run_id = ? ORDER BY id",
                (run_id,),
            ).fetchall()
        results = []
        for rr in rows:
            d = dict(zip(res_cols, rr))
            d["answered"] = bool(d["answered"]) if d["answered"] is not None else None
            d["passed"] = bool(d["passed"]) if d["passed"] is not None else None
            d["failed_checks"] = json.loads(d["failed_checks"]) if d["failed_checks"] else []
            results.append(d)
        run["results"] = results
        return run

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
