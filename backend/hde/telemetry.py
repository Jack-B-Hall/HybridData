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

Multi-turn chat conversations also live here (``chat_conversations`` +
``chat_turns``): they are user-session state, not corpus data, so they belong in
the writable database and survive corpus rebuilds. Every chat turn additionally
logs a normal ``asks`` row (that is what system health and thumbs feedback key
on); the ``chat_turns`` row carries the conversation-specific extras (raw
message, condensed rewrite, full result payload).
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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'general',
  behaviour     TEXT    NOT NULL DEFAULT 'answer',      -- 'answer' | 'refuse'
  citations     TEXT,                                   -- JSON list of expected artifact ids
  keywords      TEXT,                                   -- JSON list of expected keywords/phrases
  golden_answer TEXT,                                   -- reference answer (optional; ANSWER questions)
  enabled       INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS test_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  status          TEXT    NOT NULL,                  -- 'ok' | 'error'
  backend         TEXT,
  judge_backend   TEXT,                              -- judge model, or null when no judge ran
  scope           TEXT,                              -- which questions ran, e.g. 'all enabled'
  total           INTEGER, passed INTEGER, failed INTEGER,
  answer_rate     REAL,                              -- correct-answer rate on ANSWER questions
  refusal_rate    REAL,                              -- correct-refusal rate on REFUSE questions
  mean_composite  REAL,                              -- mean composite score (0-100)
  mean_latency_ms INTEGER,
  duration_ms     INTEGER,
  error           TEXT
);
CREATE TABLE IF NOT EXISTS test_results (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL,
  question_id        INTEGER,
  question           TEXT,
  category           TEXT,
  behaviour          TEXT,
  answered           INTEGER,
  verdict            TEXT,
  passed             INTEGER,
  failed_checks      TEXT,                           -- JSON list of failure reasons
  retrieval_score    REAL,                           -- deterministic sub-score (0-1)
  judged             INTEGER,                         -- 1 if the judge scored this answer
  judge_correctness  REAL,                           -- rubric dims (0-1), null when not judged
  judge_groundedness REAL,
  judge_completeness REAL,
  judge_citation     REAL,
  judge_justification TEXT,
  composite          REAL,                           -- final per-question score (0-100)
  latency_ms         INTEGER,
  error              TEXT,
  FOREIGN KEY (run_id) REFERENCES test_runs(id)
);
CREATE TABLE IF NOT EXISTS chat_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  title      TEXT
);
CREATE TABLE IF NOT EXISTS chat_turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  ts              TEXT    NOT NULL,
  message         TEXT    NOT NULL,                 -- raw user message
  rewritten       TEXT,                             -- condensed standalone question
  rewrite_method  TEXT,                             -- 'raw' | 'llm' | 'mock'
  ask_id          INTEGER,                          -- the asks row logged for this turn
  answered        INTEGER,
  verdict         TEXT,
  confidence      TEXT,
  answer          TEXT,
  cited_ids       TEXT,                             -- JSON list of cited artifact ids
  result          TEXT,                             -- full result payload (JSON)
  latency_ms      INTEGER,
  backend         TEXT,
  status          TEXT    NOT NULL DEFAULT 'ok',    -- 'ok' | 'error'
  error           TEXT,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_asks_ts ON asks(ts);
CREATE INDEX IF NOT EXISTS idx_chat_turns_conversation ON chat_turns(conversation_id);
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
        self._migrate()
        self.conn.commit()
        self._lock = threading.Lock()

    def _migrate(self) -> None:
        """Add columns introduced after a table's first release. IF NOT EXISTS on
        CREATE won't add columns to a pre-existing table (e.g. the telemetry volume
        that survives image rebuilds), so bring older DBs up to the current shape."""
        additions = {
            "golden_questions": [("golden_answer", "TEXT")],
            "test_runs": [("judge_backend", "TEXT"), ("mean_composite", "REAL")],
            "test_results": [
                ("retrieval_score", "REAL"), ("judged", "INTEGER"),
                ("judge_correctness", "REAL"), ("judge_groundedness", "REAL"),
                ("judge_completeness", "REAL"), ("judge_citation", "REAL"),
                ("judge_justification", "TEXT"), ("composite", "REAL"),
            ],
        }
        for table, cols in additions.items():
            existing = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            for name, coltype in cols:
                if name not in existing:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {coltype}")

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

    # ── chat conversations (multi-turn, survives corpus clears) ───────────────
    _TURN_COLS = (
        "id", "conversation_id", "ts", "message", "rewritten", "rewrite_method",
        "ask_id", "answered", "verdict", "confidence", "answer", "cited_ids",
        "result", "latency_ms", "backend", "status", "error",
    )

    def create_conversation(self, title: str | None = None) -> dict:
        now = _now()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO chat_conversations (created_at, updated_at, title) VALUES (?,?,?)",
                (now, now, title),
            )
            self.conn.commit()
            cid = int(cur.lastrowid)
        return {"id": cid, "created_at": now, "updated_at": now, "title": title, "n_turns": 0}

    def list_conversations(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT c.id, c.created_at, c.updated_at, c.title, "
                "(SELECT COUNT(*) FROM chat_turns t WHERE t.conversation_id = c.id) "
                "FROM chat_conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"id": r[0], "created_at": r[1], "updated_at": r[2], "title": r[3], "n_turns": r[4]}
            for r in rows
        ]

    @staticmethod
    def _turn_row(r) -> dict:
        d = dict(zip(Telemetry._TURN_COLS, r))
        d["answered"] = bool(d["answered"]) if d["answered"] is not None else None
        d["cited_ids"] = json.loads(d["cited_ids"]) if d["cited_ids"] else []
        d["result"] = json.loads(d["result"]) if d["result"] else None
        return d

    def get_conversation(self, cid: int) -> dict | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT id, created_at, updated_at, title FROM chat_conversations WHERE id = ?",
                (cid,),
            ).fetchone()
            if not row:
                return None
            turns = self.conn.execute(
                f"SELECT {', '.join(self._TURN_COLS)} FROM chat_turns "
                "WHERE conversation_id = ? ORDER BY id",
                (cid,),
            ).fetchall()
        parsed = [self._turn_row(t) for t in turns]
        return {
            "id": row[0], "created_at": row[1], "updated_at": row[2], "title": row[3],
            "n_turns": len(parsed), "turns": parsed,
        }

    def conversation_exists(self, cid: int) -> bool:
        with self._lock:
            return self.conn.execute(
                "SELECT 1 FROM chat_conversations WHERE id = ?", (cid,)
            ).fetchone() is not None

    def rename_conversation(self, cid: int, title: str) -> bool:
        with self._lock:
            cur = self.conn.execute(
                "UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, _now(), cid),
            )
            self.conn.commit()
            return cur.rowcount > 0

    def delete_conversation(self, cid: int) -> bool:
        with self._lock:
            self.conn.execute("DELETE FROM chat_turns WHERE conversation_id = ?", (cid,))
            cur = self.conn.execute("DELETE FROM chat_conversations WHERE id = ?", (cid,))
            self.conn.commit()
            return cur.rowcount > 0

    def recent_turns(self, cid: int, limit: int = 20) -> list[dict]:
        """The newest completed turns of a conversation, oldest first: the raw
        material for the condensation/history window."""
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(self._TURN_COLS)} FROM chat_turns "
                "WHERE conversation_id = ? AND status = 'ok' ORDER BY id DESC LIMIT ?",
                (cid, limit),
            ).fetchall()
        return [self._turn_row(r) for r in reversed(rows)]

    def log_chat_turn(self, turn: dict) -> int | None:
        """Persist one completed (or failed) chat turn and bump the conversation's
        updated_at. Best-effort like every telemetry write. A conversation with no
        title inherits the first message as its display title."""
        cols = [c for c in self._TURN_COLS if c != "id"]
        row = dict(turn)
        row["ts"] = row.get("ts") or _now()
        if row.get("cited_ids") is not None:
            row["cited_ids"] = json.dumps(row["cited_ids"])
        if row.get("result") is not None:
            row["result"] = json.dumps(row["result"])
        try:
            with self._lock:
                # The conversation may have been deleted while this turn was in
                # flight (SQLite FKs are not enforced here); re-check inside the
                # lock and drop the write rather than leave an orphan row.
                exists = self.conn.execute(
                    "SELECT 1 FROM chat_conversations WHERE id = ?",
                    (row.get("conversation_id"),),
                ).fetchone()
                if exists is None:
                    return None
                cur = self.conn.execute(
                    f"INSERT INTO chat_turns ({', '.join(cols)}) "
                    f"VALUES ({', '.join('?' * len(cols))})",
                    tuple(row.get(c) for c in cols),
                )
                self.conn.execute(
                    "UPDATE chat_conversations SET updated_at = ?, "
                    "title = COALESCE(title, ?) WHERE id = ?",
                    (_now(), str(row.get("message", ""))[:80] or None,
                     row.get("conversation_id")),
                )
                self.conn.commit()
                return int(cur.lastrowid)
        except sqlite3.Error:
            return None

    # ── golden-set questions (writable, survives corpus clears) ───────────────
    _GOLDEN_COLS = (
        "id", "text", "category", "behaviour", "citations", "keywords",
        "golden_answer", "enabled", "notes", "created_at", "updated_at",
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
                    "keywords, golden_answer, enabled, notes, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (q["text"], q.get("category", "general"), q.get("behaviour", "answer"),
                     json.dumps(q.get("citations", [])), json.dumps(q.get("keywords", [])),
                     q.get("golden_answer"), int(q.get("enabled", True)), q.get("notes"), now, now),
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
                "keywords, golden_answer, enabled, notes, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (q["text"], q.get("category", "general"), q.get("behaviour", "answer"),
                 json.dumps(q.get("citations", [])), json.dumps(q.get("keywords", [])),
                 q.get("golden_answer"), int(q.get("enabled", True)), q.get("notes"), now, now),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def update_golden(self, qid: int, fields: dict) -> bool:
        allowed = {"text", "category", "behaviour", "citations", "keywords",
                   "golden_answer", "enabled", "notes"}
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
    # Column order is shared by insert (minus id/run_id) and select (plus id).
    _RUN_COLS = (
        "started_at", "finished_at", "status", "backend", "judge_backend", "scope",
        "total", "passed", "failed", "answer_rate", "refusal_rate", "mean_composite",
        "mean_latency_ms", "duration_ms", "error",
    )
    _RESULT_COLS = (
        "question_id", "question", "category", "behaviour", "answered", "verdict",
        "passed", "failed_checks", "retrieval_score", "judged", "judge_correctness",
        "judge_groundedness", "judge_completeness", "judge_citation",
        "judge_justification", "composite", "latency_ms", "error",
    )

    def log_test_run(self, run: dict, results: list[dict]) -> int | None:
        try:
            with self._lock:
                cur = self.conn.execute(
                    f"INSERT INTO test_runs ({', '.join(self._RUN_COLS)}) "
                    f"VALUES ({', '.join('?' * len(self._RUN_COLS))})",
                    tuple(run.get(c) for c in self._RUN_COLS),
                )
                run_id = int(cur.lastrowid)
                for res in results:
                    row = dict(res)
                    row["failed_checks"] = json.dumps(res.get("failed_checks") or [])
                    self.conn.execute(
                        f"INSERT INTO test_results (run_id, {', '.join(self._RESULT_COLS)}) "
                        f"VALUES (?, {', '.join('?' * len(self._RESULT_COLS))})",
                        (run_id, *(row.get(c) for c in self._RESULT_COLS)),
                    )
                self.conn.commit()
                return run_id
        except sqlite3.Error:
            return None

    def test_runs(self, limit: int = 25) -> list[dict]:
        cols = ("id", *self._RUN_COLS)
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {', '.join(cols)} FROM test_runs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    def test_run(self, run_id: int) -> dict | None:
        run_cols = ("id", *self._RUN_COLS)
        res_cols = ("id", *self._RESULT_COLS)
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
            d["judged"] = bool(d["judged"]) if d["judged"] is not None else None
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
