"""Data-agnosticism: the engine adapts to non-demo id shapes, adapter-declared
provenance tiers, and corpus branding — without editing the core.

These prove the *new* behaviour; the bit-identical-default guarantee is covered
by the rest of the suite passing unchanged.
"""
from __future__ import annotations

import pytest

from hde import store
from hde.config import Settings
from hde.engine import Engine
from hde.ingest import Record, SourceAdapter, ingest


class _WidgetAdapter(SourceAdapter):
    """A tiny non-engineering corpus with numeric ids and a novel source label."""

    source = "SAP"  # not in the built-in SOURCE_TIER map -> informal by default

    def corpus_meta(self) -> dict:
        return {
            "title": "Widgets",
            "placeholder": "Ask about widgets…",
            "starter_questions": [{"text": "What is 000123?", "hint": "lookup"}],
        }

    def records(self):
        yield Record("000100", "entity", "Widget Assembly", "Top-level widget assembly.", source="SAP")
        yield Record(
            "000123", "document", "Widget Specification",
            "Specification 000123 for the widget. The torque setting is 12 Nm.",
            source="SAP", prov_tier=1, refs=["000100"],
        )


def _widget_engine(tmp_path, **overrides) -> Engine:
    settings = Settings(
        db_path=tmp_path / "widgets.db", telemetry_db=tmp_path / "t.db",
        embedder="hash", llm_backend="mock", **overrides,
    )
    ingest(_WidgetAdapter(), settings, reset=True)
    return Engine(settings)


def test_id_pattern_is_persisted_and_anchors_numeric_ids(tmp_path):
    eng = _widget_engine(tmp_path, id_pattern=r"\b\d{4,6}\b")
    try:
        # The ingest-time pattern is persisted, so query-time matching agrees.
        assert store.get_meta(eng.conn, "id_pattern") == r"\b\d{4,6}\b"
        # A purely-numeric id is recognised as an anchor — impossible with the
        # default PREFIX-digits pattern.
        result = eng.ask("what does 000123 specify")
        assert "000123" in result.signals["question_ids"]
        assert result.signals["id_anchor"] is True
    finally:
        eng.close()


def test_default_pattern_does_not_anchor_numeric_ids(tmp_path):
    # Same corpus, default id pattern: the numeric id is NOT treated as an id.
    eng = _widget_engine(tmp_path)
    try:
        result = eng.ask("what does 000123 specify")
        assert result.signals["question_ids"] == []
    finally:
        eng.close()


def test_adapter_declared_prov_tier_wins_over_source_map(tmp_path):
    eng = _widget_engine(tmp_path)
    try:
        # 000123 declared prov_tier=1 despite its unknown "SAP" source.
        assert eng.get_document("000123")["prov_tier"] == 1
        # 000100 declared none -> derived from source ("SAP" unknown -> informal 3).
        assert eng.get_document("000100")["prov_tier"] == 3
    finally:
        eng.close()


def test_corpus_meta_comes_from_the_adapter(tmp_path):
    eng = _widget_engine(tmp_path)
    try:
        meta = eng.corpus_meta()
        assert meta["title"] == "Widgets"
        assert meta["placeholder"] == "Ask about widgets…"
        assert meta["starter_questions"][0]["text"] == "What is 000123?"
        assert meta["tier_labels"]["1"] == "formal"
    finally:
        eng.close()


def test_corpus_meta_generic_fallback_when_adapter_declares_none(tiny_engine):
    meta = tiny_engine.corpus_meta()
    assert meta["title"] is None
    assert meta["starter_questions"] == []
    assert "corpus" in meta["placeholder"].lower()


def test_gate_thresholds_and_domain_stopwords_are_configurable():
    # A non-default configuration is honoured (here: an empty domain stoplist, so
    # "system"/"change" become content terms again).
    s = Settings(gate_domain_stopwords=(), gate_cov_hi=0.5)
    from hde import gate as gate_mod

    assert "system" not in gate_mod.build_stopwords(s.gate_domain_stopwords)
    assert "the" in gate_mod.build_stopwords(s.gate_domain_stopwords)  # generic kept
