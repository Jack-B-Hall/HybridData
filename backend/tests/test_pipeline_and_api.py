"""End-to-end tests for the ask pipeline and the HTTP API."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hde.api.app import app


def test_ask_answers_and_grounds_citations(tiny_engine):
    result = tiny_engine.ask("What chemistry is the battery pack?")
    assert result.answered is True
    assert result.verdict in ("sufficient", "borderline")
    assert result.citations
    # Every cited id in the answer resolves to a retrieved chunk with a span.
    for c in result.citations:
        if c["grounded"]:
            assert c["passage"]
            assert c["char_end"] >= c["char_start"]


def test_ask_declines_off_corpus(tiny_engine):
    result = tiny_engine.ask("What is the population of Japan?")
    assert result.answered is False
    assert result.verdict == "insufficient"
    # A refusal still surfaces what WAS found.
    assert isinstance(result.sources, list)


def test_ask_reports_confidence_signals(tiny_engine):
    result = tiny_engine.ask("power module specification")
    assert result.confidence in ("high", "medium", "low")
    assert "term_coverage" in result.signals
    assert "id_anchor" in result.signals


@pytest.fixture
def client(demo_engine, monkeypatch):
    # Point the API at the same demo settings the fixture resolved.
    from hde import engine as engine_mod

    monkeypatch.setattr(engine_mod, "get_settings", lambda: demo_engine.settings)
    from hde.api import app as app_mod

    monkeypatch.setattr(app_mod, "get_settings", lambda: demo_engine.settings)
    with TestClient(app) as c:
        yield c


def test_api_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"


def test_api_ask(client):
    body = client.post("/api/ask", json={"question": "Why was the battery chemistry changed?"}).json()
    assert body["verdict"] in ("sufficient", "borderline")
    assert body["sources"]


def test_api_documents_and_detail(client):
    listing = client.get("/api/documents?limit=5").json()
    assert listing["count"] >= 1
    first = listing["documents"][0]["id"]
    detail = client.get(f"/api/documents/{first}").json()
    assert detail["id"] == first
    assert "sections" in detail


def test_api_document_404(client):
    assert client.get("/api/documents/NOPE-999").status_code == 404


def test_api_graph_overview_and_node(client):
    ov = client.get("/api/graph/overview?limit=100").json()
    assert ov["nodes"] and "edges_by_rel" in ov["stats"]
    node = ov["nodes"][0]["id"]
    nb = client.get(f"/api/graph/node/{node}?hops=1").json()
    assert nb["center"] == node


def test_api_corpus_stats(client):
    stats = client.get("/api/corpus/stats").json()
    assert stats["totals"]["artifacts"] > 0
    assert set(stats["by_tier"]) <= {"formal", "unverified", "informal"}
