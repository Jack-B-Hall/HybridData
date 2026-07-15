"""End-to-end tests for the ask pipeline and the HTTP API."""
from __future__ import annotations

import json

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


def _collect_sse(client, question):
    events = []
    with client.stream("POST", "/api/ask/stream", json={"question": question}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def test_api_ask_stream_answerable(client):
    events = _collect_sse(client, "Why was the battery chemistry changed?")
    types = [e["type"] for e in events]
    # First a retrieval event, at least one token, and a terminal done event.
    assert types[0] == "retrieval"
    assert types[-1] == "done"
    assert "token" in types

    retrieval = events[0]
    assert retrieval["answered"] is True
    assert retrieval["sources"]  # sources available before generation completes

    done = events[-1]["result"]
    # The streamed prose reassembles to the final answer, with citations resolved.
    streamed = "".join(e["text"] for e in events if e["type"] == "token")
    assert streamed.strip()
    assert done["answered"] is True
    assert done["citations"]
    assert done["backend"] == retrieval["backend"]


def test_api_ask_stream_refusal_has_no_tokens(client):
    events = _collect_sse(client, "What is the population of Japan?")
    types = [e["type"] for e in events]
    assert types[0] == "retrieval"
    assert types[-1] == "done"
    assert "token" not in types  # a declined question streams no answer prose
    assert events[0]["answered"] is False
    assert events[-1]["result"]["answered"] is False


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


def test_api_feedback_round_trip_and_health(client):
    ask = client.post("/api/ask", json={"question": "Why was the battery chemistry changed?"}).json()
    ask_id = ask["ask_id"]
    assert ask_id > 0

    ok = client.post("/api/feedback", json={"ask_id": ask_id, "rating": "down", "comment": "wanted more"})
    assert ok.status_code == 200 and ok.json()["ok"] is True

    # Unknown ask -> 404; invalid rating -> 422 (validated by the request model).
    assert client.post("/api/feedback", json={"ask_id": 10_000_000, "rating": "up"}).status_code == 404
    assert client.post("/api/feedback", json={"ask_id": ask_id, "rating": "meh"}).status_code == 422

    health = client.get("/api/telemetry/health").json()
    assert health["totals"]["asks"] >= 1
    assert "p50_ms" in health["latency"] and "p95_ms" in health["latency"]
    assert health["feedback"]["down"] >= 1
    assert isinstance(health["recent"], list) and health["recent"]


def test_api_stream_logs_ask_id(client):
    events = []
    with client.stream("POST", "/api/ask/stream", json={"question": "Why was the battery chemistry changed?"}) as r:
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    done = events[-1]
    assert done["type"] == "done"
    assert done["result"]["ask_id"] > 0


def test_api_corpus_meta_shape(client):
    meta = client.get("/api/corpus/meta").json()
    assert "placeholder" in meta and isinstance(meta["starter_questions"], list)
    assert "id_pattern" in meta and meta["id_pattern"]
    assert meta["tier_labels"]["1"] == "formal"


def test_api_corpus_stats(client):
    stats = client.get("/api/corpus/stats").json()
    assert stats["totals"]["artifacts"] > 0
    assert set(stats["by_tier"]) <= {"formal", "unverified", "informal"}


def test_inline_id_citations_rewritten_to_markers():
    """A live model that writes '[ECN-312]' inline should render as numeric chips."""
    from hde.synthesis import _rewrite_inline_citations

    prose = "Voss approved the change [ECN-312, ECR-214]. It affected P-1062 [P-1062]."
    out = _rewrite_inline_citations(prose, {"ECN-312": 1, "ECR-214": 2, "P-1062": 3})
    assert "[1][2]" in out and "[3]" in out
    assert "ECN-312" not in out  # bracketed ids replaced by markers


def test_inline_rewrite_leaves_valid_numeric_markers():
    from hde.synthesis import _rewrite_inline_citations

    prose = "See [1] and [2]."
    assert _rewrite_inline_citations(prose, {"a": 1, "b": 2}, n_citations=2) == prose


def test_inline_rewrite_splits_numeric_groups_and_clamps():
    from hde.synthesis import _rewrite_inline_citations

    # "[1, 4]" -> "[1]" ([4] is out of range for 2 citations).
    out = _rewrite_inline_citations("Approved [1, 4].", {"a": 1, "b": 2}, n_citations=2)
    assert "[1]" in out and "[4]" not in out


def test_clean_markup_strips_markdown_and_latex():
    from hde.synthesis import _clean_markup

    raw = "## Summary\n**ECR-214** changes chemistry `LiFePO4` $\\rightarrow$ done.\n* item one\n* item two"
    out = _clean_markup(raw)
    assert "**" not in out and "`" not in out and "##" not in out
    assert "$" not in out and "→" in out
    assert "ECR-214" in out and "LiFePO4" in out
    assert "• item one" in out
