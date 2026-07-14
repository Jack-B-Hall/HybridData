"""Tests for the knowledge graph traversal and chunking spans."""
from __future__ import annotations

from hde.chunking import chunk_text


def test_chunking_single_chunk_span():
    chunks = chunk_text("A short body.", "X-1", "Title")
    assert len(chunks) == 1
    assert chunks[0].char_start == 0
    assert chunks[0].char_end == len("A short body.")
    assert chunks[0].body.startswith("X-1 | Title")


def test_chunking_splits_and_spans_are_ordered():
    body = "\n\n".join(f"Paragraph number {i} with enough text to matter." * 12 for i in range(6))
    chunks = chunk_text(body, "X-2", "Big Doc", max_chars=400)
    assert len(chunks) > 1
    # Spans are non-overlapping and increasing.
    prev_end = -1
    for c in chunks:
        assert c.char_start >= prev_end
        prev_end = c.char_end
    assert chunks[-1].char_end <= len(body.strip())


def test_graph_hierarchy_walks(tiny_engine):
    kg = tiny_engine.kg
    # A-2 (Power Module) rolls up into A-1 (Widget Assembly).
    ancestors = [n.id for n in kg.ancestors("A-2")]
    assert ancestors == ["A-1"]
    descendants = {n.id for n in kg.descendants("A-1")}
    assert {"A-2", "A-3"} <= descendants


def test_graph_documents_for_entity(tiny_engine):
    docs = {n.id for n in tiny_engine.kg.documents_for("A-2")}
    assert "D-1" in docs  # spec DESCRIBES the power module


def test_graph_closure_direction(tiny_engine):
    closure = tiny_engine.kg.closure("A-2")
    assert closure is not None
    # The spec and ticket both reference A-2, so changing A-2 impacts them.
    assert set(closure["downstream_ids"]) >= {"D-1", "T-1"}


def test_graph_neighborhood_bounded(tiny_engine):
    nb = tiny_engine.kg.neighborhood("A-2", hops=1)
    ids = {n.id for n in nb.nodes}
    assert "A-2" in ids
    assert nb.edges  # has at least one edge
    assert len(nb.nodes) <= 60


def test_graph_stats_shape(tiny_engine):
    stats = tiny_engine.kg.stats()
    assert stats["nodes"] >= 5
    assert "PART_OF" in stats["edges_by_rel"]
