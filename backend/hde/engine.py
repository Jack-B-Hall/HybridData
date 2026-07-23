"""The engine facade: one object that owns the open store and answers questions.

This is the stateful seam the API and CLI sit on. It keeps a single SQLite
connection, a knowledge-graph view, an embedder, and an answer model, and exposes
the operations the product surface needs: ask a question, browse documents, walk
the graph, and report corpus statistics.

``ask`` is the full pipeline:

    retrieve (fused) -> gate (deterministic) -> if answerable: gather graph paths
    + closures, then synthesize with citations; if not: decline with what was found.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import chat as chat_mod
from . import gate as gate_mod
from . import ids as ids_mod
from . import store
from .config import Settings, get_settings
from .embeddings import Embedder, build_embedder
from .graph import KnowledgeGraph
from .llm import LLMClient, build_llm
from .retrieval import retrieve
from .synthesis import stream_synthesis, synthesize
from .telemetry import Telemetry, _now as _telemetry_now

CONFIDENCE = {"sufficient": "high", "borderline": "medium", "insufficient": "low"}

REFUSAL_TEXT = (
    "This question does not appear to be covered by the current corpus, so I will "
    "not answer it rather than risk inventing details. The most related records "
    "found are listed below."
)


@dataclass
class AskResult:
    question: str
    answered: bool
    verdict: str
    confidence: str
    answer: str
    signals: dict = field(default_factory=dict)
    claims: list[dict] = field(default_factory=list)
    citations: list[dict] = field(default_factory=list)
    graph_paths: list[str] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    latency_ms: int = 0
    backend: str = ""
    retrieval: dict = field(default_factory=dict)
    # Telemetry row id for this ask, so the UI can attach thumbs feedback to it.
    ask_id: int = 0

    def as_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class _Prepared:
    """The materialised result of the locked retrieval/gate/graph phase."""

    chunks: list
    debug: dict
    verdict: str
    answerable: bool
    signals: dict
    graph_paths: list[str]
    closures: list[dict]


class Engine:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        embedder: Embedder | None = None,
        llm: LLMClient | None = None,
        shared: bool = False,
    ) -> None:
        self.settings = settings or get_settings()
        self._shared = shared
        # ``shared=True`` is the serving path: one connection across the request
        # threadpool, guarded by ``self._lock`` (the workload is read-only).
        self.conn: sqlite3.Connection = store.connect(
            self.settings.db_path, check_same_thread=not shared
        )
        self.kg = KnowledgeGraph(self.conn)
        self.embedder = embedder or build_embedder(self.settings)
        self.llm = llm or build_llm(self.settings)
        self._lock = threading.Lock()
        # Resolve the record-id pattern from the store's meta (what the corpus was
        # ingested with) so query-time matching equals ingest-time; fall back to
        # the configured default. Gate thresholds/stopwords come from settings.
        self.id_re = ids_mod.build_id_re(
            store.get_meta(self.conn, "id_pattern") or self.settings.id_pattern
        )
        self.gate_thresholds = gate_mod.GateThresholds(
            cov_hi=self.settings.gate_cov_hi,
            cov_mid=self.settings.gate_cov_mid,
            cov_void=self.settings.gate_cov_void,
            strong_frac=self.settings.gate_strong_frac,
        )
        self.gate_stopwords = gate_mod.build_stopwords(self.settings.gate_domain_stopwords)
        # Telemetry has its own connection + lock (separate writable DB), so it is
        # never contended with the corpus lock and best-effort by construction.
        self.telemetry = Telemetry(self.settings.telemetry_db)

    def close(self) -> None:
        self.conn.close()
        self.telemetry.close()

    def swap_store(self, new_db_path: Path | str) -> None:
        """Atomically replace the corpus store with a freshly-built one at
        ``new_db_path`` and reload the connection. Held under the engine lock so
        no query is in its DB phase; in-flight streams use already-materialised
        data (no corpus-connection access after retrieval) and are unaffected.

        Only the fast file swap + reopen runs under the lock — the slow ingest
        happened into a temp DB beforehand — so this never wedges the engine.
        """
        with self._lock:
            self.conn.close()
            os.replace(os.fspath(new_db_path), os.fspath(self.settings.db_path))
            self.conn = store.connect(self.settings.db_path, check_same_thread=not self._shared)
            self.kg = KnowledgeGraph(self.conn)
            self.id_re = ids_mod.build_id_re(
                store.get_meta(self.conn, "id_pattern") or self.settings.id_pattern
            )

    # ── ask ────────────────────────────────────────────────────────────────
    def ask(self, question: str) -> AskResult:
        return self._ask(question)

    def _ask(self, question: str) -> AskResult:
        t0 = time.time()
        # Lock only the SQLite-touching phase (retrieve + gate + graph expansion);
        # the answer model touches no shared DB state, so it must not hold the lock.
        prep = self._prepare(question)
        retrieval_ms = int((time.time() - t0) * 1000)
        sources = [c.as_dict() for c in prep.chunks]

        if not prep.answerable:
            result = AskResult(
                question=question, answered=False, verdict=prep.verdict,
                confidence=CONFIDENCE[prep.verdict], answer=REFUSAL_TEXT,
                signals=prep.signals, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=prep.debug,
            )
            self._log(result, retrieval_ms=retrieval_ms, llm_ms=0, streamed=False)
            return result

        llm_t0 = time.time()
        answer = synthesize(
            self.llm, question, prep.chunks, prep.graph_paths, prep.closures,
            borderline=(prep.verdict == "borderline"), id_re=self.id_re,
        )
        llm_ms = int((time.time() - llm_t0) * 1000)
        result = AskResult(
            question=question, answered=True, verdict=prep.verdict,
            confidence=CONFIDENCE[prep.verdict], answer=answer.text,
            signals=prep.signals,
            claims=[c.as_dict() for c in answer.claims],
            citations=[c.as_dict() for c in answer.citations],
            graph_paths=answer.graph_paths, sources=sources,
            latency_ms=int((time.time() - t0) * 1000),
            backend=self.llm.name, retrieval=prep.debug,
        )
        self._log(result, retrieval_ms=retrieval_ms, llm_ms=llm_ms, streamed=False)
        return result

    # ── retrieval + gate (the locked, DB-touching phase) ─────────────────────
    def _prepare(self, question: str) -> "_Prepared":
        """Run retrieval, the gate, and (if answerable) graph expansion under the
        connection lock, and return everything the lock-free answer phase needs.

        Everything returned is fully materialised (chunks, closures, path strings,
        signal dicts), so the caller can generate the answer without the lock —
        which is what keeps a slow or abandoned stream from wedging the engine.
        """
        with self._lock:
            chunks, debug = retrieve(
                self.conn, self.kg, self.embedder, question, self.settings, self.id_re
            )
            verdict_result = gate_mod.evaluate(
                self.conn, question, chunks, self.gate_thresholds, self.id_re, self.gate_stopwords
            )
            verdict = verdict_result.verdict
            answerable = verdict != "insufficient"
            entry_ids = [c.artifact_id for c in chunks]
            graph_paths = self.kg.expand_paths(entry_ids) if answerable else []
            closures = self.kg.closures(entry_ids[:4]) if answerable else []
        return _Prepared(
            chunks=chunks, debug=debug, verdict=verdict, answerable=answerable,
            signals=verdict_result.signals, graph_paths=graph_paths, closures=closures,
        )

    def _log(self, result: AskResult, *, retrieval_ms: int, llm_ms: int,
             streamed: bool, status: str = "ok", error: str | None = None) -> None:
        ask_id = self.telemetry.log_ask(
            question=result.question, verdict=result.verdict, confidence=result.confidence,
            answered=result.answered, backend=result.backend, latency_ms=result.latency_ms,
            retrieval_ms=retrieval_ms, llm_ms=llm_ms, n_sources=len(result.sources),
            n_graph_paths=len(result.graph_paths), answer_chars=len(result.answer),
            streamed=streamed, status=status, error=error,
        )
        if ask_id:
            result.ask_id = ask_id

    # ── ask (streaming) ──────────────────────────────────────────────────────
    def ask_stream(self, question: str):
        """Yield the ask pipeline as a sequence of events for incremental UI.

        Event shapes (each a plain dict with a ``type`` key):

        * ``retrieval`` — emitted as soon as retrieval + the gate have run:
          sources, pre-synthesis graph paths, gate verdict/signals, backend, and
          whether the question will be answered. The UI populates the sources
          panel and the staged status from this.
        * ``token`` — a newly-displayable slice of answer prose (answerable case
          only), streamed from the model.
        * ``done`` — the final, fully-parsed result (identical shape to
          :meth:`ask`'s ``as_dict``), with citations resolved and timing.

        The blocking :meth:`ask` is unchanged; this is a parallel path so the
        CLI, tests, and the ``/api/ask`` contract keep their exact behaviour.

        The engine lock is held ONLY across the DB phase (see :meth:`_prepare`)
        and released before the model streams, so a client that abandons the
        stream mid-generation cannot wedge the engine for every later request.
        """
        return self._ask_stream(question)

    def _ask_stream(self, question: str):
        t0 = time.time()
        prep = self._prepare(question)  # locked; released before the LLM streams
        retrieval_ms = int((time.time() - t0) * 1000)
        sources = [c.as_dict() for c in prep.chunks]

        yield {
            "type": "retrieval",
            "answered": prep.answerable,
            "verdict": prep.verdict,
            "confidence": CONFIDENCE[prep.verdict],
            "signals": prep.signals,
            "backend": self.llm.name,
            "sources": sources,
            "graph_paths": prep.graph_paths,
            "retrieval": prep.debug,
        }

        if not prep.answerable:
            result = AskResult(
                question=question, answered=False, verdict=prep.verdict,
                confidence=CONFIDENCE[prep.verdict], answer=REFUSAL_TEXT,
                signals=prep.signals, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=prep.debug,
            )
            self._log(result, retrieval_ms=retrieval_ms, llm_ms=0, streamed=True)
            yield {"type": "done", "result": result.as_dict()}
            return

        llm_t0 = time.time()
        terminal_logged = False
        try:
            stream = stream_synthesis(
                self.llm, question, prep.chunks, prep.graph_paths, prep.closures,
                borderline=(prep.verdict == "borderline"), id_re=self.id_re,
            )
            # Drive the synthesis generator manually so we can forward each prose
            # delta as a token event and capture the parsed Answer it returns.
            while True:
                try:
                    piece = next(stream)
                except StopIteration as stop:
                    answer = stop.value
                    break
                yield {"type": "token", "text": piece}

            llm_ms = int((time.time() - llm_t0) * 1000)
            result = AskResult(
                question=question, answered=True, verdict=prep.verdict,
                confidence=CONFIDENCE[prep.verdict], answer=answer.text,
                signals=prep.signals,
                claims=[c.as_dict() for c in answer.claims],
                citations=[c.as_dict() for c in answer.citations],
                graph_paths=answer.graph_paths, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=prep.debug,
            )
            self._log(result, retrieval_ms=retrieval_ms, llm_ms=llm_ms, streamed=True)
            terminal_logged = True
            yield {"type": "done", "result": result.as_dict()}
        except GeneratorExit:
            # Client disconnected mid-generation (tab nav, reload). Record it as
            # an abandoned ask so it is visible in system health, then let the
            # close propagate. No yield here — the generator is being torn down.
            if not terminal_logged:
                self._log_incomplete(question, prep, retrieval_ms,
                                     int((time.time() - llm_t0) * 1000), status="abandoned")
            raise
        except Exception as exc:
            if not terminal_logged:
                self._log_incomplete(question, prep, retrieval_ms,
                                     int((time.time() - llm_t0) * 1000),
                                     status="error", error=str(exc))
            raise

    def _log_incomplete(self, question: str, prep: "_Prepared", retrieval_ms: int,
                        llm_ms: int, *, status: str, error: str | None = None) -> None:
        """Log a stream that ended before ``done`` (abandoned or errored)."""
        self.telemetry.log_ask(
            question=question, verdict=prep.verdict, confidence=CONFIDENCE[prep.verdict],
            answered=prep.answerable, backend=self.llm.name,
            latency_ms=retrieval_ms + llm_ms, retrieval_ms=retrieval_ms, llm_ms=llm_ms,
            n_sources=len(prep.chunks), n_graph_paths=len(prep.graph_paths),
            answer_chars=0, streamed=True, status=status, error=error,
        )

    # ── chat (multi-turn conversations) ──────────────────────────────────────
    # Per user turn: condense (message + bounded history -> one standalone
    # question), then run the SAME pipeline as a single-shot ask against it:
    # fresh fused retrieval, the deterministic gate, and grounded synthesis
    # (which additionally sees the bounded history window, for continuity only).
    # The engine lock is held only inside _prepare, exactly like ask/ask_stream;
    # neither condensation nor the model stream ever holds it.

    def create_conversation(self, title: str | None = None) -> dict:
        return self.telemetry.create_conversation(title)

    def list_conversations(self, limit: int = 100) -> list[dict]:
        return self.telemetry.list_conversations(limit)

    def get_conversation(self, cid: int) -> dict | None:
        return self.telemetry.get_conversation(cid)

    def rename_conversation(self, cid: int, title: str) -> bool:
        return self.telemetry.rename_conversation(cid, title)

    def delete_conversation(self, cid: int) -> bool:
        return self.telemetry.delete_conversation(cid)

    def _chat_window(self, cid: int) -> list[chat_mod.HistoryTurn]:
        """The bounded history window for a conversation's next turn."""
        turns = [
            chat_mod.HistoryTurn(
                message=t["message"], answer=t.get("answer") or "",
                cited_ids=t.get("cited_ids") or [],
                answered=bool(t.get("answered")),
            )
            for t in self.telemetry.recent_turns(cid, limit=max(self.settings.chat_history_turns, 1))
        ]
        return chat_mod.bound_history(
            turns, self.settings.chat_history_turns, self.settings.chat_history_char_budget
        )

    def chat_turn(self, cid: int, message: str) -> dict:
        """Run one blocking chat turn; returns the persisted turn payload.

        Raises the underlying exception if synthesis fails (the API maps it to
        a clean per-turn HTTP error)."""
        final: dict | None = None
        error: str | None = None
        for event in self.chat_turn_stream(cid, message):
            if event["type"] == "done":
                final = event["turn"]
            elif event["type"] == "error":
                error = event["message"]
        if final is None:
            raise RuntimeError(error or "chat turn produced no result")
        return final

    def chat_turn_stream(self, cid: int, message: str):
        """Yield one chat turn as a sequence of events for incremental UI.

        Event order mirrors :meth:`ask_stream`, with one chat-specific prefix:

        * ``rewrite``   the condensed standalone question this turn will
          retrieve on (also carried in the final turn payload).
        * ``retrieval`` sources + graph paths + gate verdict, as in ask_stream.
        * ``token``     answer prose deltas (answerable turns only).
        * ``done``      the persisted turn: raw message, rewrite, and a result
          payload shaped exactly like a single-shot ask result.

        The engine lock is held only across the DB phase (:meth:`_prepare`),
        never across the model stream; a mid-generation failure is logged and
        surfaced as a per-turn error event rather than a hang.
        """
        t0 = time.time()
        window = self._chat_window(cid)
        cond = chat_mod.condense(
            self.llm, message, window, self.id_re,
            timeout_s=self.settings.chat_condense_timeout_s,
        )
        yield {
            "type": "rewrite",
            "conversation_id": cid,
            "message": message,
            "rewritten": cond.question,
            "rewrite_method": cond.method,
        }

        prep = self._prepare(cond.question)  # locked; released before the LLM streams
        retrieval_ms = int((time.time() - t0) * 1000)
        sources = [c.as_dict() for c in prep.chunks]

        yield {
            "type": "retrieval",
            "answered": prep.answerable,
            "verdict": prep.verdict,
            "confidence": CONFIDENCE[prep.verdict],
            "signals": prep.signals,
            "backend": self.llm.name,
            "sources": sources,
            "graph_paths": prep.graph_paths,
            "retrieval": prep.debug,
        }

        if not prep.answerable:
            result = AskResult(
                question=cond.question, answered=False, verdict=prep.verdict,
                confidence=CONFIDENCE[prep.verdict], answer=REFUSAL_TEXT,
                signals=prep.signals, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=prep.debug,
            )
            self._log(result, retrieval_ms=retrieval_ms, llm_ms=0, streamed=True)
            turn = self._log_chat_turn(cid, message, cond, result)
            yield {"type": "done", "turn": turn}
            return

        llm_t0 = time.time()
        try:
            stream = stream_synthesis(
                self.llm, cond.question, prep.chunks, prep.graph_paths, prep.closures,
                borderline=(prep.verdict == "borderline"), id_re=self.id_re,
                history=chat_mod.render_history_block(window) if window else None,
            )
            while True:
                try:
                    piece = next(stream)
                except StopIteration as stop:
                    answer = stop.value
                    break
                yield {"type": "token", "text": piece}
        except GeneratorExit:
            self._log_incomplete(cond.question, prep, retrieval_ms,
                                 int((time.time() - llm_t0) * 1000), status="abandoned")
            raise
        except Exception as exc:
            self._log_incomplete(cond.question, prep, retrieval_ms,
                                 int((time.time() - llm_t0) * 1000),
                                 status="error", error=str(exc))
            self.telemetry.log_chat_turn({
                "conversation_id": cid, "message": message,
                "rewritten": cond.question, "rewrite_method": cond.method,
                "backend": self.llm.name, "status": "error", "error": str(exc),
                "latency_ms": int((time.time() - t0) * 1000),
            })
            yield {"type": "error", "message": str(exc)}
            return

        llm_ms = int((time.time() - llm_t0) * 1000)
        result = AskResult(
            question=cond.question, answered=True, verdict=prep.verdict,
            confidence=CONFIDENCE[prep.verdict], answer=answer.text,
            signals=prep.signals,
            claims=[c.as_dict() for c in answer.claims],
            citations=[c.as_dict() for c in answer.citations],
            graph_paths=answer.graph_paths, sources=sources,
            latency_ms=int((time.time() - t0) * 1000),
            backend=self.llm.name, retrieval=prep.debug,
        )
        self._log(result, retrieval_ms=retrieval_ms, llm_ms=llm_ms, streamed=True)
        turn = self._log_chat_turn(cid, message, cond, result)
        yield {"type": "done", "turn": turn}

    def _log_chat_turn(
        self, cid: int, message: str, cond: "chat_mod.CondensedQuestion", result: AskResult
    ) -> dict:
        """Persist a completed turn and return the payload the API/UI use."""
        result_dict = result.as_dict()
        turn = {
            "conversation_id": cid,
            "ts": _telemetry_now(),
            "message": message,
            "rewritten": cond.question,
            "rewrite_method": cond.method,
            "ask_id": result.ask_id or None,
            "answered": int(result.answered),
            "verdict": result.verdict,
            "confidence": result.confidence,
            "answer": result.answer,
            "cited_ids": [c["artifact_id"] for c in result_dict["citations"]],
            "result": result_dict,
            "latency_ms": result.latency_ms,
            "backend": result.backend,
            "status": "ok",
            "error": None,
        }
        turn_id = self.telemetry.log_chat_turn(turn)
        payload = dict(turn)
        payload["id"] = turn_id or 0
        payload["answered"] = result.answered
        payload["ask_id"] = result.ask_id
        return payload

    # ── feedback + system health ─────────────────────────────────────────────
    def submit_feedback(self, ask_id: int, rating: str, comment: str | None = None) -> int | None:
        return self.telemetry.add_feedback(ask_id, rating, comment)

    def telemetry_health(self, recent_limit: int = 25) -> dict:
        return self.telemetry.health(recent_limit=recent_limit)

    # ── documents ────────────────────────────────────────────────────────────
    def list_documents(
        self, *, kind: str | None = None, source: str | None = None,
        subsystem: str | None = None, query: str | None = None, limit: int = 200,
    ) -> list[dict]:
        with self._lock:
            return self._list_documents(kind, source, subsystem, query, limit)

    def _list_documents(self, kind, source, subsystem, query, limit) -> list[dict]:
        clauses, params = [], []
        if kind:
            clauses.append("kind = ?"); params.append(kind)
        if source:
            clauses.append("source = ?"); params.append(source)
        if subsystem:
            clauses.append("subsystem = ?"); params.append(subsystem)
        if query:
            clauses.append("(id LIKE ? OR title LIKE ?)")
            params += [f"%{query}%", f"%{query}%"]
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"SELECT id, kind, title, source, prov_tier, subsystem FROM artifacts "
            f"{where} ORDER BY id LIMIT ?",
            (*params, limit),
        ).fetchall()
        from . import provenance
        return [
            {"id": r[0], "kind": r[1], "title": r[2], "source": r[3],
             "prov_tier": r[4], "tier_label": provenance.label_for(r[4]), "subsystem": r[5]}
            for r in rows
        ]

    def get_document(self, artifact_id: str) -> dict | None:
        with self._lock:
            return self._get_document(artifact_id)

    def _get_document(self, artifact_id: str) -> dict | None:
        from . import provenance
        row = self.conn.execute(
            "SELECT id, kind, title, text, source, prov_tier, subsystem, parent_id, metadata "
            "FROM artifacts WHERE id = ?",
            (artifact_id,),
        ).fetchone()
        if not row:
            return None
        sections = [
            {"chunk_idx": s[0], "char_start": s[1], "char_end": s[2], "body": s[3]}
            for s in self.conn.execute(
                "SELECT chunk_idx, char_start, char_end, body FROM chunks "
                "WHERE artifact_id = ? ORDER BY chunk_idx",
                (artifact_id,),
            )
        ]
        refs = [r[0] for r in self.conn.execute(
            "SELECT ref_id FROM refs WHERE artifact_id = ? ORDER BY ref_id", (artifact_id,))]
        referenced_by = [r[0] for r in self.conn.execute(
            "SELECT artifact_id FROM refs WHERE ref_id = ? ORDER BY artifact_id", (artifact_id,))]
        return {
            "id": row[0], "kind": row[1], "title": row[2], "text": row[3],
            "source": row[4], "prov_tier": row[5], "tier_label": provenance.label_for(row[5]),
            "subsystem": row[6], "parent_id": row[7], "metadata": json.loads(row[8]),
            "sections": sections, "refs": refs, "referenced_by": referenced_by,
            "closure": self.kg.closure(artifact_id),
        }

    # ── graph ────────────────────────────────────────────────────────────────
    def graph_neighborhood(self, node_id: str, hops: int = 1) -> dict:
        with self._lock:
            nb = self.kg.neighborhood(node_id, hops=hops)
            return {
                "center": nb.center,
                "nodes": [n.__dict__ for n in nb.nodes],
                "edges": [e.__dict__ for e in nb.edges],
            }

    def graph_overview(self, limit: int = 400) -> dict:
        with self._lock:
            return self._graph_overview(limit)

    def _graph_overview(self, limit: int = 400) -> dict:
        """A capped whole-graph view for the explorer's initial render."""
        nodes = [
            {"id": r[0], "kind": r[1], "label": r[2], "subsystem": r[3],
             "source": r[4], "prov_tier": r[5]}
            for r in self.conn.execute(
                "SELECT id, kind, label, subsystem, source, prov_tier FROM graph_nodes LIMIT ?",
                (limit,),
            )
        ]
        ids = {n["id"] for n in nodes}
        edges = [
            {"src": r[0], "dst": r[1], "rel": r[2]}
            for r in self.conn.execute("SELECT src, dst, rel FROM graph_edges")
            if r[0] in ids and r[1] in ids
        ]
        return {"nodes": nodes, "edges": edges, "stats": self.kg.stats()}

    # ── corpus stats ─────────────────────────────────────────────────────────
    def corpus_meta(self) -> dict:
        """Corpus branding for the UI (title, chat placeholder, starter questions),
        the record-id pattern, and tier labels — from adapter/ingest metadata in
        the DB, with generic fallbacks so an un-branded corpus still reads sensibly."""
        from . import provenance

        with self._lock:
            raw = store.get_meta(self.conn, "corpus_meta")
            id_pattern = store.get_meta(self.conn, "id_pattern") or self.settings.id_pattern
        declared: dict = {}
        if raw:
            try:
                declared = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                declared = {}
        # Precedence: adapter/DB corpus_meta (from ingest) wins, then config-file
        # branding (Settings), then a generic fallback.
        cfg_starters = [{"text": t, "hint": h} for (t, h) in self.settings.corpus_starter_questions]
        return {
            "title": declared.get("title") or self.settings.corpus_title,
            "placeholder": declared.get("placeholder")
            or self.settings.corpus_placeholder
            or "Ask about the corpus — records, changes, decisions, relationships…",
            "starter_questions": declared.get("starter_questions") or cfg_starters or [],
            # App branding: adapter/DB meta wins, then config file, then built-in.
            "app_name": declared.get("app_name") or self.settings.corpus_app_name or "Hybrid-Data-Example",
            "app_icon": declared.get("app_icon") or self.settings.corpus_app_icon,
            "id_pattern": id_pattern,
            "tier_labels": {str(t): provenance.label_for(t) for t in (1, 2, 3)},
            # Per-tab enablement ([ui.tabs] in config), so the frontend can hide
            # switched-off tabs and guard their routes.
            "tabs": dict(self.settings.ui_tabs),
        }

    def corpus_stats(self) -> dict:
        with self._lock:
            return self._corpus_stats()

    def _corpus_stats(self) -> dict:
        from . import provenance
        by_kind = {r[0]: r[1] for r in self.conn.execute(
            "SELECT kind, COUNT(*) FROM artifacts GROUP BY kind")}
        by_source = {r[0]: r[1] for r in self.conn.execute(
            "SELECT source, COUNT(*) FROM artifacts GROUP BY source ORDER BY source")}
        by_tier = {provenance.label_for(r[0]): r[1] for r in self.conn.execute(
            "SELECT prov_tier, COUNT(*) FROM artifacts GROUP BY prov_tier")}
        by_subsystem = {(r[0] or "unassigned"): r[1] for r in self.conn.execute(
            "SELECT subsystem, COUNT(*) FROM artifacts GROUP BY subsystem ORDER BY COUNT(*) DESC")}
        totals = {
            "artifacts": self.conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0],
            "chunks": self.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
            "refs": self.conn.execute("SELECT COUNT(*) FROM refs").fetchone()[0],
        }
        return {
            "totals": totals, "by_kind": by_kind, "by_source": by_source,
            "by_tier": by_tier, "by_subsystem": by_subsystem,
            "graph": self.kg.stats(),
            "embedder": store.get_meta(self.conn, "embedder"),
            "embed_dim": store.get_meta(self.conn, "embed_dim"),
            "snapshot_at": store.get_meta(self.conn, "snapshot_at"),
        }

    def ingest_history(self) -> list[dict]:
        with self._lock:
            return self._ingest_history()

    def _ingest_history(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, started_at, finished_at, adapter, source_path, n_records, "
            "n_chunks, n_nodes, n_edges, status, note FROM ingest_runs ORDER BY id DESC"
        ).fetchall()
        cols = ["id", "started_at", "finished_at", "adapter", "source_path",
                "n_records", "n_chunks", "n_nodes", "n_edges", "status", "note"]
        return [dict(zip(cols, r)) for r in rows]


def open_engine(db_path: Path | None = None, **kwargs) -> Engine:
    settings = get_settings()
    if db_path is not None:
        settings = Settings(**{**settings.__dict__, "db_path": db_path})
    return Engine(settings, **kwargs)
