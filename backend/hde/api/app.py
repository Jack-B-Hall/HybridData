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

import json
from contextlib import asynccontextmanager
from typing import Iterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..config import get_settings
from ..engine import Engine
from ..ingestion import IngestBadRequest, IngestBusy, IngestManager
from ..testing import TestBusy, TestManager


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)


class FeedbackRequest(BaseModel):
    ask_id: int = Field(..., ge=1)
    rating: str = Field(..., pattern="^(up|down)$")
    comment: str | None = Field(default=None, max_length=2000)


class IngestStartRequest(BaseModel):
    action: str = Field(..., pattern="^(reingest|scan|clear)$")
    confirm: str | None = Field(default=None, max_length=64)


class GoldenQuestionIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    category: str = Field(default="general", max_length=64)
    behaviour: str = Field(default="answer", pattern="^(answer|refuse)$")
    citations: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    enabled: bool = True
    notes: str | None = Field(default=None, max_length=2000)


class GoldenQuestionPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=1000)
    category: str | None = Field(default=None, max_length=64)
    behaviour: str | None = Field(default=None, pattern="^(answer|refuse)$")
    citations: list[str] | None = None
    keywords: list[str] | None = None
    enabled: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)


class TestRunRequest(BaseModel):
    categories: list[str] | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.engine = Engine(settings, shared=True)
    app.state.ingest = IngestManager(app.state.engine)
    app.state.testing = TestManager(app.state.engine)
    app.state.testing.seed_if_empty()
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


def _sse(event: dict) -> str:
    """Serialise one event as a Server-Sent Events frame."""
    return f"data: {json.dumps(event)}\n\n"


@app.post("/api/ask/stream")
def ask_stream(req: AskRequest) -> StreamingResponse:
    """Stream the ask pipeline as Server-Sent Events.

    Emits ``retrieval`` (sources + graph paths + gate verdict, as soon as they
    are computed), then ``token`` frames (answer prose as the model generates
    it), then a final ``done`` frame with resolved citations and timing. The
    blocking :func:`ask` endpoint above is unchanged for compatibility.
    """
    eng = _engine()

    def frames() -> Iterator[str]:
        try:
            for event in eng.ask_stream(req.question):
                yield _sse(event)
        except Exception as exc:  # surface as a stream event, not a broken socket
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/feedback")
def feedback(req: FeedbackRequest) -> dict:
    """Attach thumbs feedback (+ optional comment) to a previously-logged ask."""
    comment = (req.comment or "").strip() or None
    feedback_id = _engine().submit_feedback(req.ask_id, req.rating, comment)
    if feedback_id is None:
        raise HTTPException(status_code=404, detail=f"no ask {req.ask_id}")
    return {"ok": True, "feedback_id": feedback_id}


@app.get("/api/telemetry/health")
def telemetry_health(recent: int = Query(25, ge=1, le=200)) -> dict:
    """System-health metrics: ask volume, answer/refusal rate, latency, feedback."""
    return _engine().telemetry_health(recent_limit=recent)


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


@app.get("/api/corpus/meta")
def corpus_meta() -> dict:
    """Corpus branding (title, chat placeholder, starter questions), the record-id
    pattern, and tier labels — so the UI carries no compiled-in demo copy."""
    return _engine().corpus_meta()


@app.get("/api/corpus/stats")
def corpus_stats() -> dict:
    return _engine().corpus_stats()


def _ingest() -> IngestManager:
    return app.state.ingest


@app.post("/api/ingest/start")
def ingest_start(req: IngestStartRequest) -> dict:
    """Start a corpus job (reingest | scan | clear). One at a time (409 if busy);
    clear needs the confirm token so it can't fire accidentally."""
    try:
        return _ingest().start(req.action, req.confirm)
    except IngestBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except IngestBadRequest as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/ingest/status")
def ingest_status() -> dict:
    """Current (or last) job status: running flag, stage, and counts."""
    return _ingest().status()


@app.get("/api/ingest/jobs")
def ingest_jobs(limit: int = Query(25, ge=1, le=200)) -> dict:
    """Persistent ingest-run history (survives corpus rebuilds/clears)."""
    return {"jobs": _ingest().history(limit)}


@app.get("/api/ingest/history")
def ingest_history() -> dict:
    return {"runs": _engine().ingest_history()}


# ── Testing (golden set + health test runs) ─────────────────────────────────
def _testing() -> TestManager:
    return app.state.testing


@app.get("/api/testing/questions")
def testing_questions(
    category: str | None = None,
    behaviour: str | None = None,
    enabled: bool | None = None,
) -> dict:
    """The golden set, optionally filtered by category / behaviour / enabled."""
    qs = _engine().telemetry.list_golden(
        category=category, behaviour=behaviour, enabled=enabled
    )
    return {"count": len(qs), "questions": qs}


@app.post("/api/testing/questions", status_code=201)
def testing_add_question(req: GoldenQuestionIn) -> dict:
    qid = _engine().telemetry.add_golden(req.model_dump())
    return _engine().telemetry.get_golden(qid)


@app.patch("/api/testing/questions/{qid}")
def testing_update_question(qid: int, req: GoldenQuestionPatch) -> dict:
    fields = req.model_dump(exclude_unset=True)
    if not _engine().telemetry.update_golden(qid, fields):
        raise HTTPException(status_code=404, detail=f"no golden question {qid}")
    return _engine().telemetry.get_golden(qid)


@app.delete("/api/testing/questions/{qid}")
def testing_delete_question(qid: int) -> dict:
    if not _engine().telemetry.delete_golden(qid):
        raise HTTPException(status_code=404, detail=f"no golden question {qid}")
    return {"ok": True, "deleted": qid}


@app.post("/api/testing/run")
def testing_run(req: TestRunRequest) -> dict:
    """Kick a background test run over the enabled golden set (optionally a subset
    of categories). One at a time (409 if a run is in progress); fire-and-forget."""
    try:
        return _testing().start(req.categories)
    except TestBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/testing/run/status")
def testing_run_status() -> dict:
    """Current (or last) run: running flag, stage, and live pass/fail tallies."""
    return _testing().status()


@app.get("/api/testing/runs")
def testing_runs(limit: int = Query(25, ge=1, le=200)) -> dict:
    """Persistent test-run history (survives corpus rebuilds/clears)."""
    return {"runs": _testing().history(limit)}


@app.get("/api/testing/runs/{run_id}")
def testing_run_detail(run_id: int) -> dict:
    """One run's summary plus its per-question results and failure reasons."""
    detail = _testing().run_detail(run_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"no test run {run_id}")
    return detail


# ── Static frontend ────────────────────────────────────────────────────────
# When a built single-page app is present (frontend/dist by default), serve it
# from the same origin as the API. The app uses relative /api paths and
# client-side routing, so hashed assets are mounted directly and every other
# path falls back to index.html. Registered last so the /api routes above win.
_dist = settings.frontend_dist
if _dist.is_dir() and (_dist / "index.html").is_file():
    _assets = _dist / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/", include_in_schema=False)
    def _spa_root() -> FileResponse:
        return FileResponse(_dist / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_fallback(full_path: str) -> FileResponse:
        # Unknown API paths should still 404 as JSON, not silently serve the app.
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail=f"no route /{full_path}")
        candidate = (_dist / full_path).resolve()
        if candidate.is_file() and _dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
