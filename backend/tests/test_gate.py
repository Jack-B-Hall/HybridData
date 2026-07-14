"""Tests for the deterministic evidence-sufficiency gate."""
from __future__ import annotations

from hde import gate
from hde.gate import GateThresholds, decide, explicit_ids


def test_explicit_ids_extracts_record_ids():
    ids = explicit_ids("How does ECR-214 relate to P-1062 and ECN-312?")
    assert ids == ["ECR-214", "P-1062", "ECN-312"]


def test_content_terms_drop_stopwords_and_ids():
    terms = gate._content_terms("What is the thermal runaway risk for P-1062?")
    assert "thermal" in terms and "runaway" in terms
    assert "the" not in terms and "what" not in terms
    assert "P-1062" not in terms  # id handled by the anchor, not coverage


def test_decide_sufficient_on_high_coverage():
    signals = {"n_chunks": 5, "term_coverage": 0.8, "id_anchor": False, "top_score": 0.03}
    assert decide(signals) == "sufficient"


def test_decide_sufficient_on_anchor_with_moderate_coverage():
    signals = {"n_chunks": 5, "term_coverage": 0.25, "id_anchor": True, "top_score": 0.03}
    assert decide(signals) == "sufficient"


def test_decide_insufficient_on_void():
    signals = {"n_chunks": 5, "term_coverage": 0.1, "id_anchor": False, "top_score": 0.02}
    assert decide(signals) == "insufficient"


def test_decide_borderline_in_middle_band():
    signals = {"n_chunks": 5, "term_coverage": 0.28, "id_anchor": False, "top_score": 0.03}
    assert decide(signals) == "borderline"


def test_decide_insufficient_on_empty_retrieval():
    assert decide({"n_chunks": 0, "term_coverage": 0.0, "id_anchor": False, "top_score": 0.0}) \
        == "insufficient"


def test_thresholds_are_configurable():
    strict = GateThresholds(cov_hi=0.9, cov_mid=0.9, cov_void=0.5)
    signals = {"n_chunks": 5, "term_coverage": 0.6, "id_anchor": False, "top_score": 0.03}
    assert decide(signals, strict) == "borderline"  # below cov_hi, above cov_void


def test_evaluate_end_to_end_answerable(tiny_engine):
    from hde.retrieval import retrieve

    chunks, _ = retrieve(
        tiny_engine.conn, tiny_engine.kg, tiny_engine.embedder,
        "What chemistry is the battery pack?", tiny_engine.settings,
    )
    result = gate.evaluate(tiny_engine.conn, "What chemistry is the battery pack?", chunks)
    assert result.verdict in ("sufficient", "borderline")
    assert result.signals["n_chunks"] > 0


def test_evaluate_end_to_end_void(tiny_engine):
    from hde.retrieval import retrieve

    q = "What is the capital city of France?"
    chunks, _ = retrieve(tiny_engine.conn, tiny_engine.kg, tiny_engine.embedder, q, tiny_engine.settings)
    result = gate.evaluate(tiny_engine.conn, q, chunks)
    assert result.verdict == "insufficient"
