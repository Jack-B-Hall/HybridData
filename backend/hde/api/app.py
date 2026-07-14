"""FastAPI application exposing the hde engine.

Endpoints (all under ``/api``):

    GET  /api/health                      liveness + backend info
    POST /api/ask                         answer a question (with gate + citations)
    GET  /api/documents                   list/filter records
    GET  /api/documents/{id}              one record with sections, refs, closure
    GET  /api/graph/overview              capped whole-graph view for the explorer
    GET  /api/graph/node/{id}             a node's neighbourhood subgraph
    GET  /api/corpus/stats                corpus + graph statistics
    GET  /api/ingest/history              ingestion run history

The engine (and its SQLite connection) is opened once at startup and shared; the
serving workload is read-only and guarded by a lock in the engine.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..config import get_settings
from ..engine import Engine


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.engine = Engine(settings, shared=True)
    try:
        yield
    finally:
        app.state.engine.close()


app = FastAPI(
    title="Hybrid-Data-Example API",
    version="1.0.0",
    description="Hybrid RAG + knowledge-graph document intelligence.",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _engine() -> Engine:
    return app.state.engine


@app.get("/api/health")
def health() -> dict:
    eng = _engine()
    return {
        "status": "ok",
        "llm_backend": eng.llm.name,
        "embedder": eng.settings.embedder,
        "db": str(eng.settings.db_path),
    }


@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    return _engine().ask(req.question).as_dict()


@app.get("/api/documents")
def list_documents(
    kind: str | None = None,
    source: str | None = None,
    subsystem: str | None = None,
    query: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
) -> dict:
    docs = _engine().list_documents(
        kind=kind, source=source, subsystem=subsystem, query=query, limit=limit
    )
    return {"count": len(docs), "documents": docs}


@app.get("/api/documents/{artifact_id}")
def get_document(artifact_id: str) -> dict:
    doc = _engine().get_document(artifact_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"no document {artifact_id!r}")
    return doc


@app.get("/api/graph/overview")
def graph_overview(limit: int = Query(400, ge=1, le=2000)) -> dict:
    return _engine().graph_overview(limit=limit)


@app.get("/api/graph/node/{node_id}")
def graph_node(node_id: str, hops: int = Query(1, ge=1, le=3)) -> dict:
    eng = _engine()
    if not eng.kg.exists(node_id):
        raise HTTPException(status_code=404, detail=f"no node {node_id!r}")
    return eng.graph_neighborhood(node_id, hops=hops)


@app.get("/api/corpus/stats")
def corpus_stats() -> dict:
    return _engine().corpus_stats()


@app.get("/api/ingest/history")
def ingest_history() -> dict:
    return {"runs": _engine().ingest_history()}
