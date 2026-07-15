"""The ingestion runner.

Turns a stream of :class:`~hde.ingest.base.Record` objects from one or more
adapters into a fully queryable store, in a single pass that is identical for
every source:

    parse (adapters)
      -> provenance-tag        (source label -> tier)
      -> persist artifacts+refs
      -> chunk + embed         (FTS5 + vector index)
      -> build knowledge graph (hierarchy backbone + typed edges + people)
      -> precompute closures   (impact/dependency, for graph-first answers)

Snapshot semantics: ingesting a record id replaces any superseded version of it.
``reset=True`` (the default for a demo build) starts from an empty database.
"""
from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import chain
from pathlib import Path
from typing import Callable, Iterable

from .. import provenance, store
from ..chunking import chunk_text
from ..config import Settings, get_settings
from ..embeddings import Embedder, build_embedder
from .base import Record, SourceAdapter

EMBED_BATCH = 32
CLOSURE_MAX_HOPS = 3
CLOSURE_ID_CAP = 40

ProgressFn = Callable[[str], None]


@dataclass
class IngestResult:
    n_records: int
    n_chunks: int
    n_nodes: int
    n_edges: int
    n_closures: int
    adapters: list[str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _tier(rec: Record) -> int:
    """Provenance tier for a record: adapter-declared value wins, else derived
    from the ``source`` label via :data:`hde.provenance.SOURCE_TIER`."""
    return rec.prov_tier if rec.prov_tier is not None else provenance.tier_for(rec.source)


def _collect(adapters: Iterable[SourceAdapter]) -> list[Record]:
    """Materialise records, applying snapshot replacement (last id wins)."""
    by_id: dict[str, Record] = {}
    for rec in chain.from_iterable(adapters):
        by_id[rec.id] = rec  # later occurrence supersedes earlier
    return list(by_id.values())


def _bfs(start: str, adj: dict[str, list[str]], max_hops: int) -> list[str]:
    seen = {start}
    order: list[str] = []
    frontier = deque([(start, 0)])
    while frontier:
        node, depth = frontier.popleft()
        if depth >= max_hops:
            continue
        for nxt in adj.get(node, []):
            if nxt not in seen:
                seen.add(nxt)
                order.append(nxt)
                frontier.append((nxt, depth + 1))
    return order[:CLOSURE_ID_CAP]


def ingest(
    adapters: SourceAdapter | Iterable[SourceAdapter],
    settings: Settings | None = None,
    *,
    reset: bool = True,
    embedder: Embedder | None = None,
    progress: ProgressFn | None = None,
) -> IngestResult:
    settings = settings or get_settings()
    embedder = embedder or build_embedder(settings)
    log = progress or (lambda _msg: None)
    if isinstance(adapters, SourceAdapter):
        adapters = [adapters]
    adapters = list(adapters)

    db_path: Path = settings.db_path
    if reset and db_path.exists():
        db_path.unlink()
        for suffix in ("-wal", "-shm"):
            side = db_path.with_name(db_path.name + suffix)
            if side.exists():
                side.unlink()

    conn = store.connect(db_path, create=True)
    store.initialise(conn, embedder.dim)
    store.set_meta(conn, "embedder", settings.embedder)
    store.set_meta(conn, "snapshot_at", _now())
    # Persist the record-id shape used at ingest so query-time id matching
    # (exact-id leg, gate anchor, citation grounding) always agrees with it.
    store.set_meta(conn, "id_pattern", settings.id_pattern)
    # Persist any adapter-declared corpus branding (title, placeholder, starter
    # questions) for /api/corpus/meta. First adapter that declares it wins.
    for adapter in adapters:
        cm = adapter.corpus_meta()
        if cm:
            store.set_meta(conn, "corpus_meta", json.dumps(cm))
            break

    log("parsing records from adapters")
    records = _collect(adapters)
    known_ids = {r.id for r in records}

    run_id = conn.execute(
        "INSERT INTO ingest_runs(started_at, adapter, source_path, status) VALUES (?, ?, ?, 'running')",
        (_now(), ", ".join(type(a).__name__ for a in adapters), str(db_path)),
    ).lastrowid
    conn.commit()

    # ── persist artifacts + refs ───────────────────────────────────────────
    for rec in records:
        if not reset:
            store.delete_artifact(conn, rec.id)
        tier = _tier(rec)
        conn.execute(
            "INSERT OR REPLACE INTO artifacts"
            "(id, kind, title, text, source, prov_tier, subsystem, parent_id, metadata) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (rec.id, rec.kind, rec.title, rec.text, rec.source, tier,
             rec.subsystem, rec.parent_id, json.dumps(rec.metadata)),
        )
        for ref in rec.refs:
            conn.execute(
                "INSERT OR IGNORE INTO refs(artifact_id, ref_id) VALUES (?, ?)",
                (rec.id, ref),
            )
    conn.commit()

    # ── chunk + embed ──────────────────────────────────────────────────────
    log("chunking + embedding")
    pending: list[tuple[Record, object]] = []  # (record, Chunk)
    for rec in records:
        if not rec.text.strip() and rec.kind == "entity":
            # Pure structural node with no prose: index its title only.
            continue
        for ch in chunk_text(rec.text or rec.title, rec.id, rec.title):
            pending.append((rec, ch))

    n_chunks = _embed_and_store(conn, pending, embedder, log)

    # ── knowledge graph ────────────────────────────────────────────────────
    log("building knowledge graph")
    n_nodes, n_edges = _build_graph(conn, records, known_ids)

    # ── impact / dependency closures ───────────────────────────────────────
    log("precomputing impact closures")
    n_closures = _build_closures(conn, records, known_ids)

    conn.execute(
        "UPDATE ingest_runs SET finished_at=?, n_records=?, n_chunks=?, n_nodes=?, "
        "n_edges=?, status='completed' WHERE id=?",
        (_now(), len(records), n_chunks, n_nodes, n_edges, run_id),
    )
    conn.commit()
    conn.close()

    return IngestResult(
        n_records=len(records),
        n_chunks=n_chunks,
        n_nodes=n_nodes,
        n_edges=n_edges,
        n_closures=n_closures,
        adapters=[type(a).__name__ for a in adapters],
    )


def _embed_and_store(conn, pending, embedder, log) -> int:
    import sqlite_vec

    total = 0
    for i in range(0, len(pending), EMBED_BATCH):
        batch = pending[i : i + EMBED_BATCH]
        vecs = embedder.embed([ch.body[:8000] for _rec, ch in batch])
        for (rec, ch), vec in zip(batch, vecs):
            cur = conn.execute(
                "INSERT INTO chunks"
                "(artifact_id, source, art_kind, title, prov_tier, chunk_idx, "
                " char_start, char_end, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (rec.id, rec.source, rec.kind, rec.title,
                 _tier(rec), ch.chunk_idx,
                 ch.char_start, ch.char_end, ch.body),
            )
            conn.execute(
                "INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)",
                (cur.lastrowid, sqlite_vec.serialize_float32(vec)),
            )
            total += 1
        if (i // EMBED_BATCH) % 10 == 0:
            conn.commit()
            log(f"  embedded {total}/{len(pending)} chunks")
    conn.commit()
    return total


def _build_graph(conn, records: list[Record], known_ids: set[str]) -> tuple[int, int]:
    for rec in records:
        conn.execute(
            "INSERT OR REPLACE INTO graph_nodes(id, kind, label, subsystem, source, prov_tier) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (rec.id, rec.kind, rec.title, rec.subsystem, rec.source,
             _tier(rec)),
        )

    edges: set[tuple[str, str, str]] = set()
    for rec in records:
        # Structural backbone: child PART_OF parent.
        if rec.kind == "entity" and rec.parent_id and rec.parent_id in known_ids:
            edges.add((rec.id, rec.parent_id, "PART_OF"))
        # Typed relations declared by the adapter.
        typed_targets: set[str] = set()
        for rel in rec.relations:
            if rel.target_id in known_ids:
                edges.add((rec.id, rel.target_id, rel.rel))
                typed_targets.add(rel.target_id)
        # Any remaining plain refs become untyped REFERENCES edges.
        for ref in rec.refs:
            if ref in known_ids and ref not in typed_targets:
                edges.add((rec.id, ref, "REFERENCES"))

    conn.executemany(
        "INSERT OR IGNORE INTO graph_edges(src, dst, rel) VALUES (?, ?, ?)",
        list(edges),
    )
    conn.commit()
    return len(records), len(edges)


def _build_closures(conn, records: list[Record], known_ids: set[str]) -> int:
    title_of = {r.id: r.title for r in records}
    tier_of = {r.id: _tier(r) for r in records}

    forward: dict[str, list[str]] = {}   # id -> ids it references / is part of
    reverse: dict[str, list[str]] = {}   # id -> ids that reference / contain it
    for rec in records:
        deps = [r for r in rec.refs if r in known_ids]
        if rec.kind == "entity" and rec.parent_id in known_ids:
            deps.append(rec.parent_id)
        forward[rec.id] = deps
        for d in deps:
            reverse.setdefault(d, []).append(rec.id)

    def _render(ids: list[str]) -> str:
        return ", ".join(f"{i} ({title_of.get(i, '?')[:40]})" for i in ids) or "none"

    written = 0
    for rec in records:
        downstream = _bfs(rec.id, reverse, CLOSURE_MAX_HOPS)
        upstream = _bfs(rec.id, forward, CLOSURE_MAX_HOPS)
        summary = (
            f"Impact/dependency closure for {rec.id} ({title_of.get(rec.id, '?')}) "
            f"[{provenance.label_for(tier_of[rec.id])}].\n"
            f"Impacted if changed ({len(downstream)} records, <={CLOSURE_MAX_HOPS} hops): "
            f"{_render(downstream)}.\n"
            f"Depends on ({len(upstream)} records, <={CLOSURE_MAX_HOPS} hops): "
            f"{_render(upstream)}."
        )
        conn.execute(
            "INSERT OR REPLACE INTO impact_closures"
            "(artifact_id, title, prov_tier, downstream_ids, upstream_ids, summary) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (rec.id, title_of.get(rec.id), tier_of[rec.id],
             json.dumps(downstream), json.dumps(upstream), summary),
        )
        written += 1
    conn.commit()
    return written
