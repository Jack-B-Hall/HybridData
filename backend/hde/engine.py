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
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import gate as gate_mod
from . import store
from .config import Settings, get_settings
from .embeddings import Embedder, build_embedder
from .graph import KnowledgeGraph
from .llm import LLMClient, build_llm
from .retrieval import retrieve
from .synthesis import stream_synthesis, synthesize

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

    def as_dict(self) -> dict:
        return self.__dict__.copy()


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
        # ``shared=True`` is the serving path: one connection across the request
        # threadpool, guarded by ``self._lock`` (the workload is read-only).
        self.conn: sqlite3.Connection = store.connect(
            self.settings.db_path, check_same_thread=not shared
        )
        self.kg = KnowledgeGraph(self.conn)
        self.embedder = embedder or build_embedder(self.settings)
        self.llm = llm or build_llm(self.settings)
        self._lock = threading.Lock()

    def close(self) -> None:
        self.conn.close()

    # ── ask ────────────────────────────────────────────────────────────────
    def ask(self, question: str) -> AskResult:
        with self._lock:
            return self._ask(question)

    def _ask(self, question: str) -> AskResult:
        t0 = time.time()
        chunks, debug = retrieve(self.conn, self.kg, self.embedder, question, self.settings)
        verdict_result = gate_mod.evaluate(self.conn, question, chunks)
        verdict = verdict_result.verdict
        sources = [c.as_dict() for c in chunks]

        if verdict == "insufficient":
            return AskResult(
                question=question, answered=False, verdict=verdict,
                confidence=CONFIDENCE[verdict], answer=REFUSAL_TEXT,
                signals=verdict_result.signals, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=debug,
            )

        entry_ids = [c.artifact_id for c in chunks]
        graph_paths = self.kg.expand_paths(entry_ids)
        closures = self.kg.closures(entry_ids[:4])
        answer = synthesize(
            self.llm, question, chunks, graph_paths, closures,
            borderline=(verdict == "borderline"),
        )
        return AskResult(
            question=question, answered=True, verdict=verdict,
            confidence=CONFIDENCE[verdict], answer=answer.text,
            signals=verdict_result.signals,
            claims=[c.as_dict() for c in answer.claims],
            citations=[c.as_dict() for c in answer.citations],
            graph_paths=answer.graph_paths, sources=sources,
            latency_ms=int((time.time() - t0) * 1000),
            backend=self.llm.name, retrieval=debug,
        )

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
        """
        with self._lock:
            yield from self._ask_stream(question)

    def _ask_stream(self, question: str):
        t0 = time.time()
        chunks, debug = retrieve(self.conn, self.kg, self.embedder, question, self.settings)
        verdict_result = gate_mod.evaluate(self.conn, question, chunks)
        verdict = verdict_result.verdict
        sources = [c.as_dict() for c in chunks]
        answerable = verdict != "insufficient"

        entry_ids = [c.artifact_id for c in chunks]
        pre_paths = self.kg.expand_paths(entry_ids) if answerable else []

        yield {
            "type": "retrieval",
            "answered": answerable,
            "verdict": verdict,
            "confidence": CONFIDENCE[verdict],
            "signals": verdict_result.signals,
            "backend": self.llm.name,
            "sources": sources,
            "graph_paths": pre_paths,
            "retrieval": debug,
        }

        if not answerable:
            result = AskResult(
                question=question, answered=False, verdict=verdict,
                confidence=CONFIDENCE[verdict], answer=REFUSAL_TEXT,
                signals=verdict_result.signals, sources=sources,
                latency_ms=int((time.time() - t0) * 1000),
                backend=self.llm.name, retrieval=debug,
            )
            yield {"type": "done", "result": result.as_dict()}
            return

        closures = self.kg.closures(entry_ids[:4])
        stream = stream_synthesis(
            self.llm, question, chunks, pre_paths, closures,
            borderline=(verdict == "borderline"),
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

        result = AskResult(
            question=question, answered=True, verdict=verdict,
            confidence=CONFIDENCE[verdict], answer=answer.text,
            signals=verdict_result.signals,
            claims=[c.as_dict() for c in answer.claims],
            citations=[c.as_dict() for c in answer.citations],
            graph_paths=answer.graph_paths, sources=sources,
            latency_ms=int((time.time() - t0) * 1000),
            backend=self.llm.name, retrieval=debug,
        )
        yield {"type": "done", "result": result.as_dict()}

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
