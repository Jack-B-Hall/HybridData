"""Fused retrieval: vector + BM25 + knowledge-graph hop, combined with RRF.

Three retrievers vote on which chunks are relevant, and Reciprocal Rank Fusion
merges their rankings into one:

1. **BM25** (FTS5) — exact term and id matches (e.g. "ECR-214"), where dense
   vectors are weak.
2. **Vector** (sqlite-vec) — semantic matches, where wording differs from the
   query.
3. **Graph hop** — starting from the entities the first two legs surface, pull in
   the documents one hop away in the knowledge graph. This is what lets a question
   anchored on one part reach the change notice or ticket that acts on it, even
   when that document shares few words with the question.

After fusion each chunk's score is multiplied by its provenance-tier weight, so a
formal record edges out an equally-relevant informal one without burying it.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

from . import provenance
from .config import Settings
from .embeddings import Embedder
from .graph import KnowledgeGraph
from .ids import explicit_ids

RRF_K = 60
CANDIDATES = 20        # per-leg candidate depth
ANCHORS_FOR_HOP = 6    # top fused artifacts used to seed the graph hop

_STOP = {
    "the", "and", "for", "with", "of", "in", "to", "a", "an", "is", "are", "was",
    "were", "it", "its", "be", "at", "by", "as", "or", "that", "what", "which",
    "who", "does", "do", "did", "if", "on", "how", "when", "why", "the",
}


@dataclass
class RetrievedChunk:
    rowid: int
    artifact_id: str
    source: str
    art_kind: str
    title: str
    prov_tier: int
    tier_label: str
    chunk_idx: int
    char_start: int
    char_end: int
    body: str
    score: float
    legs: list[str] = field(default_factory=list)  # which retrievers found it

    def as_dict(self) -> dict:
        return {
            "rowid": self.rowid,
            "artifact_id": self.artifact_id,
            "source": self.source,
            "art_kind": self.art_kind,
            "title": self.title,
            "prov_tier": self.prov_tier,
            "tier_label": self.tier_label,
            "chunk_idx": self.chunk_idx,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "body": self.body,
            "score": round(self.score, 6),
            "legs": self.legs,
        }


def _fts_query(text: str) -> str:
    """Lenient OR-of-prefix FTS5 query so any content term (or id) can match."""
    tokens = [
        t for t in text.replace('"', " ").replace("*", " ").replace(":", " ").split()
        if len(t) >= 2
    ]
    content = [t for t in tokens if t.lower() not in _STOP] or tokens
    return " OR ".join(f'"{t}"*' for t in content[:12])


def _fts(conn: sqlite3.Connection, query: str, k: int) -> list[int]:
    q = _fts_query(query)
    if not q:
        return []
    try:
        rows = conn.execute(
            "SELECT rowid, -bm25(chunks_fts) AS score FROM chunks_fts "
            "WHERE chunks_fts MATCH ? ORDER BY score DESC LIMIT ?",
            (q, k),
        ).fetchall()
        return [r[0] for r in rows]
    except sqlite3.OperationalError:
        return []


def _vector(conn: sqlite3.Connection, embedder: Embedder, query: str, k: int) -> list[int]:
    import sqlite_vec

    vec = embedder.embed([query[:8000]])[0]
    rows = conn.execute(
        "SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k=? ORDER BY distance",
        (sqlite_vec.serialize_float32(vec), k),
    ).fetchall()
    return [r[0] for r in rows]


def _rrf(*ranked_lists: list[int]) -> dict[int, float]:
    scores: dict[int, float] = {}
    for lst in ranked_lists:
        for rank, rid in enumerate(lst):
            scores[rid] = scores.get(rid, 0.0) + 1.0 / (RRF_K + rank + 1)
    return scores


def _rows_for(conn: sqlite3.Connection, rowids: list[int]) -> dict[int, sqlite3.Row]:
    if not rowids:
        return {}
    ph = ",".join("?" * len(rowids))
    rows = conn.execute(
        f"SELECT id, artifact_id, source, art_kind, title, prov_tier, chunk_idx, "
        f"char_start, char_end, body FROM chunks WHERE id IN ({ph})",
        rowids,
    ).fetchall()
    return {r[0]: r for r in rows}


def _exact_id_hits(conn: sqlite3.Connection, query: str) -> list[int]:
    """Representative chunk rowids for record ids named verbatim in the query.

    An exact-match leg so a lookup like "what does ECR-214 say" always retrieves
    the named record, which dense and lexical search can otherwise rank below
    documents that merely mention it.
    """
    ids = explicit_ids(query)
    if not ids:
        return []
    ph = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT artifact_id, MIN(id) AS rowid FROM chunks WHERE artifact_id IN ({ph}) "
        f"GROUP BY artifact_id",
        ids,
    ).fetchall()
    best = {r[0]: r[1] for r in rows}
    return [best[i] for i in ids if i in best]


def _graph_hop(conn, kg: KnowledgeGraph, anchor_ids: list[str]) -> list[int]:
    """Representative chunk rowids for documents one graph hop from the anchors."""
    neighbour_ids: list[str] = []
    seen: set[str] = set(anchor_ids)
    for aid in anchor_ids[:ANCHORS_FOR_HOP]:
        for e in kg.out_edges(aid) + kg.in_edges(aid):
            for other in (e.dst, e.src):
                if other not in seen:
                    seen.add(other)
                    neighbour_ids.append(other)
    if not neighbour_ids:
        return []
    ph = ",".join("?" * len(neighbour_ids))
    rows = conn.execute(
        f"SELECT artifact_id, MIN(id) AS rowid FROM chunks WHERE artifact_id IN ({ph}) "
        f"GROUP BY artifact_id",
        neighbour_ids,
    ).fetchall()
    best = {r[0]: r[1] for r in rows}
    # Preserve neighbour proximity order.
    return [best[nid] for nid in neighbour_ids if nid in best]


def retrieve(
    conn: sqlite3.Connection,
    kg: KnowledgeGraph,
    embedder: Embedder,
    query: str,
    settings: Settings,
) -> tuple[list[RetrievedChunk], dict]:
    """Return the top fused chunks (one per artifact) and a debug breakdown."""
    exact_ids = _exact_id_hits(conn, query)
    fts_ids = _fts(conn, query, CANDIDATES)
    vec_ids = _vector(conn, embedder, query, CANDIDATES)

    # First fusion (exact + lexical + semantic) picks the entities to hop from.
    base = _rrf(exact_ids, fts_ids, vec_ids)
    base_rowids = sorted(base, key=lambda r: base[r], reverse=True)
    base_rows = _rows_for(conn, base_rowids)
    anchor_ids: list[str] = []
    for rid in base_rowids:
        aid = base_rows[rid][1]
        if aid not in anchor_ids:
            anchor_ids.append(aid)
        if len(anchor_ids) >= ANCHORS_FOR_HOP:
            break

    graph_ids = _graph_hop(conn, kg, anchor_ids)

    # Final fusion across all legs.
    fused = _rrf(exact_ids, fts_ids, vec_ids, graph_ids)
    all_rows = _rows_for(conn, list(fused))

    legs = {
        "exact": set(exact_ids), "fts": set(fts_ids),
        "vector": set(vec_ids), "graph": set(graph_ids),
    }
    chunks: list[RetrievedChunk] = []
    for rid, raw in fused.items():
        r = all_rows.get(rid)
        if not r:
            continue
        tier = r[5]
        which = [name for name, ids in legs.items() if rid in ids]
        chunks.append(
            RetrievedChunk(
                rowid=r[0], artifact_id=r[1], source=r[2], art_kind=r[3], title=r[4],
                prov_tier=tier, tier_label=provenance.label_for(tier),
                chunk_idx=r[6], char_start=r[7], char_end=r[8], body=r[9],
                score=raw * provenance.weight_for(tier), legs=which,
            )
        )
    chunks.sort(key=lambda c: c.score, reverse=True)

    # Keep the best chunk per artifact for context quality.
    seen: set[str] = set()
    top: list[RetrievedChunk] = []
    for c in chunks:
        if c.artifact_id in seen:
            continue
        seen.add(c.artifact_id)
        top.append(c)
        if len(top) >= settings.top_chunks:
            break

    debug = {
        "exact_hits": len(exact_ids),
        "fts_hits": len(fts_ids),
        "vector_hits": len(vec_ids),
        "graph_hits": len(graph_ids),
        "anchors": anchor_ids,
        "fused_candidates": len(fused),
    }
    return top, debug
