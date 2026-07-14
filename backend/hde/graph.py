"""Knowledge-graph traversal over the SQLite graph tables.

The graph has a hierarchical backbone (``PART_OF`` edges forming the assembly
tree) with documents and people attached to it by typed edges. Impact and
dependency questions — the weakest category for every pure-LLM approach — are
answered here by *traversal*, not by asking a model to reason over prose: the
precomputed closures and the live edge walk are ground truth from the structure.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field


@dataclass
class Node:
    id: str
    kind: str
    label: str
    subsystem: str | None = None
    source: str | None = None
    prov_tier: int | None = None


@dataclass
class Edge:
    src: str
    dst: str
    rel: str


@dataclass
class Neighborhood:
    center: str
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)


class KnowledgeGraph:
    """Read-only views and traversals over ``graph_nodes`` / ``graph_edges``."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    # ── node access ────────────────────────────────────────────────────────
    def node(self, node_id: str) -> Node | None:
        row = self.conn.execute(
            "SELECT id, kind, label, subsystem, source, prov_tier FROM graph_nodes WHERE id=?",
            (node_id,),
        ).fetchone()
        return _node(row) if row else None

    def exists(self, node_id: str) -> bool:
        return self.conn.execute(
            "SELECT 1 FROM graph_nodes WHERE id=?", (node_id,)
        ).fetchone() is not None

    # ── local edges ────────────────────────────────────────────────────────
    def out_edges(self, node_id: str) -> list[Edge]:
        return [
            Edge(r[0], r[1], r[2])
            for r in self.conn.execute(
                "SELECT src, dst, rel FROM graph_edges WHERE src=?", (node_id,)
            )
        ]

    def in_edges(self, node_id: str) -> list[Edge]:
        return [
            Edge(r[0], r[1], r[2])
            for r in self.conn.execute(
                "SELECT src, dst, rel FROM graph_edges WHERE dst=?", (node_id,)
            )
        ]

    # ── hierarchy walks (PART_OF backbone) ─────────────────────────────────
    def ancestors(self, node_id: str) -> list[Node]:
        """Assemblies this node rolls up into, nearest first."""
        out, seen, cur = [], {node_id}, node_id
        while True:
            row = self.conn.execute(
                "SELECT dst FROM graph_edges WHERE src=? AND rel='PART_OF'", (cur,)
            ).fetchone()
            if not row or row[0] in seen:
                break
            seen.add(row[0])
            node = self.node(row[0])
            if not node:
                break
            out.append(node)
            cur = row[0]
        return out

    def descendants(self, node_id: str, max_depth: int = 6) -> list[Node]:
        """All sub-assemblies/parts contained by this node."""
        out: list[Node] = []
        frontier = [(node_id, 0)]
        seen = {node_id}
        while frontier:
            cur, depth = frontier.pop()
            if depth >= max_depth:
                continue
            for r in self.conn.execute(
                "SELECT src FROM graph_edges WHERE dst=? AND rel='PART_OF'", (cur,)
            ):
                if r[0] not in seen:
                    seen.add(r[0])
                    node = self.node(r[0])
                    if node:
                        out.append(node)
                        frontier.append((r[0], depth + 1))
        return out

    # ── neighborhood for visualisation ─────────────────────────────────────
    def neighborhood(self, node_id: str, hops: int = 1, limit: int = 60) -> Neighborhood:
        """A bounded subgraph around ``node_id`` for the graph explorer."""
        seen = {node_id}
        frontier = {node_id}
        edges: dict[tuple[str, str, str], Edge] = {}
        for _ in range(hops):
            nxt: set[str] = set()
            for nid in frontier:
                for e in self.out_edges(nid) + self.in_edges(nid):
                    edges[(e.src, e.dst, e.rel)] = e
                    for other in (e.src, e.dst):
                        if other not in seen and len(seen) < limit:
                            seen.add(other)
                            nxt.add(other)
            frontier = nxt
            if not frontier:
                break
        nodes = [n for n in (self.node(i) for i in seen) if n]
        edge_list = [e for e in edges.values() if e.src in seen and e.dst in seen]
        return Neighborhood(center=node_id, nodes=nodes, edges=edge_list)

    # ── documents describing an entity ─────────────────────────────────────
    def documents_for(self, entity_id: str) -> list[Node]:
        rows = self.conn.execute(
            "SELECT n.id, n.kind, n.label, n.subsystem, n.source, n.prov_tier "
            "FROM graph_edges e JOIN graph_nodes n ON n.id = e.src "
            "WHERE e.dst=? AND n.kind='document'",
            (entity_id,),
        )
        return [_node(r) for r in rows]

    # ── precomputed closures ───────────────────────────────────────────────
    def closure(self, artifact_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT artifact_id, title, prov_tier, downstream_ids, upstream_ids, summary "
            "FROM impact_closures WHERE artifact_id=?",
            (artifact_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "artifact_id": row[0], "title": row[1], "prov_tier": row[2],
            "downstream_ids": json.loads(row[3]), "upstream_ids": json.loads(row[4]),
            "summary": row[5],
        }

    def closures(self, artifact_ids: list[str]) -> list[dict]:
        out = []
        for aid in artifact_ids:
            c = self.closure(aid)
            if c:
                out.append(c)
        return out

    # ── readable relationship paths from entry points ──────────────────────
    def expand_paths(self, entry_ids: list[str], limit: int = 40) -> list[str]:
        """Human-readable ``A -REL-> B`` triples anchored on the entry points,
        used as extra grounding in the synthesis context."""
        paths: list[str] = []
        seen: set[tuple[str, str, str]] = set()
        labels = self._labels_for(entry_ids)
        for eid in entry_ids[:10]:
            for e in self.out_edges(eid) + self.in_edges(eid):
                key = (e.src, e.dst, e.rel)
                if key in seen:
                    continue
                seen.add(key)
                s_label = labels.get(e.src) or self._label(e.src)
                d_label = labels.get(e.dst) or self._label(e.dst)
                paths.append(f"{e.src} ({s_label}) -{e.rel}-> {e.dst} ({d_label})")
                if len(paths) >= limit:
                    return paths
        return paths

    def _label(self, node_id: str) -> str:
        row = self.conn.execute(
            "SELECT label FROM graph_nodes WHERE id=?", (node_id,)
        ).fetchone()
        return (row[0] if row else node_id)[:40]

    def _labels_for(self, ids: list[str]) -> dict[str, str]:
        if not ids:
            return {}
        ph = ",".join("?" * len(ids))
        return {
            r[0]: (r[1] or r[0])[:40]
            for r in self.conn.execute(
                f"SELECT id, label FROM graph_nodes WHERE id IN ({ph})", ids
            )
        }

    # ── stats ──────────────────────────────────────────────────────────────
    def stats(self) -> dict:
        node_by_kind = {
            r[0]: r[1]
            for r in self.conn.execute("SELECT kind, COUNT(*) FROM graph_nodes GROUP BY kind")
        }
        edge_by_rel = {
            r[0]: r[1]
            for r in self.conn.execute("SELECT rel, COUNT(*) FROM graph_edges GROUP BY rel")
        }
        return {
            "nodes": sum(node_by_kind.values()),
            "edges": sum(edge_by_rel.values()),
            "nodes_by_kind": node_by_kind,
            "edges_by_rel": edge_by_rel,
        }


def _node(row) -> Node:
    return Node(id=row[0], kind=row[1], label=row[2], subsystem=row[3], source=row[4], prov_tier=row[5])
