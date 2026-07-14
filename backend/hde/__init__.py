"""Hybrid-Data-Example (hde) — a reference hybrid RAG + knowledge-graph
document-intelligence engine.

The package is organised as a small pipeline of single-responsibility modules:

    ingest/      source adapters + the ingestion runner (parse -> chunk -> embed
                 -> graph -> provenance-tag)
    store        SQLite schema + connection helpers (FTS5, sqlite-vec, graph,
                 impact closures) -- the whole system is one self-contained file
    embeddings   pluggable text embedder (hash fallback, Ollama, sentence-transformers)
    llm          pluggable answer model (deterministic mock, Ollama, Anthropic)
    retrieval    fused vector + BM25 + graph-hop retrieval with RRF
    graph        hierarchical knowledge graph traversal (assembly tree + closures)
    gate         deterministic evidence-sufficiency gate (no LLM self-judgement)
    synthesis    context assembly + grounded answer generation with citations
    pipeline     the end-to-end ask() orchestration
    api          FastAPI application exposing the pipeline over HTTP

Nothing here depends on an external database or a running GPU: the defaults run
fully offline so tests and the demo never require either.
"""

__version__ = "1.0.0"
