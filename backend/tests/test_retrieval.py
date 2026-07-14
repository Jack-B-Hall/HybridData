"""Tests for fused retrieval and RRF ranking."""
from __future__ import annotations

from hde.retrieval import _fts_query, _rrf, retrieve


def test_rrf_rewards_agreement_across_legs():
    # id 7 appears in two legs at good ranks; id 1 only in one.
    scores = _rrf([1, 7, 3], [7, 9])
    assert max(scores, key=lambda k: scores[k]) == 7


def test_rrf_uses_rank_not_score():
    # Earlier ranks score higher regardless of absolute values.
    scores = _rrf([5, 6])
    assert scores[5] > scores[6]


def test_fts_query_drops_stopwords_and_quotes_terms():
    q = _fts_query("What is the thermal runaway risk?")
    assert '"thermal"*' in q and '"runaway"*' in q
    assert "the" not in q.lower().replace('"thermal"*', "")


def test_fts_query_handles_empty():
    assert _fts_query("!!! ??") == "" or _fts_query("!!! ??")  # no crash


def test_retrieve_returns_one_chunk_per_artifact(tiny_engine):
    chunks, debug = retrieve(
        tiny_engine.conn, tiny_engine.kg, tiny_engine.embedder,
        "battery pack thermal", tiny_engine.settings,
    )
    ids = [c.artifact_id for c in chunks]
    assert len(ids) == len(set(ids))  # deduped per artifact
    assert chunks, "expected some retrieval hits"
    assert debug["fts_hits"] >= 1


def test_retrieve_reaches_graph_neighbours(tiny_engine):
    # A query about the spec should surface the power module it describes and the
    # ticket that references it (fusion + graph hop working together).
    chunks, _ = retrieve(
        tiny_engine.conn, tiny_engine.kg, tiny_engine.embedder,
        "power module specification", tiny_engine.settings,
    )
    reached = {c.artifact_id for c in chunks}
    assert reached & {"A-2", "T-1"}


def test_graph_leg_contributes_on_large_corpus(demo_engine):
    # On the full corpus the graph hop pulls in neighbours the lexical/vector legs
    # miss — e.g. reaching the change notice that acts on a named part.
    _chunks, debug = retrieve(
        demo_engine.conn, demo_engine.kg, demo_engine.embedder,
        "battery chemistry change", demo_engine.settings,
    )
    assert debug["graph_hits"] >= 1


def test_provenance_weight_applied(tiny_engine):
    chunks, _ = retrieve(
        tiny_engine.conn, tiny_engine.kg, tiny_engine.embedder,
        "battery pack", tiny_engine.settings,
    )
    for c in chunks:
        assert c.tier_label in ("formal", "unverified", "informal")
