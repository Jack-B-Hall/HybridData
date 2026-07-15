# Architecture

Hybrid-Data-Example answers questions over a heterogeneous document corpus by
combining three retrieval signals with a hierarchical knowledge graph, gating the
answer on a deterministic confidence check, and synthesising a cited response. It
is a clean-room reference implementation of the architecture that won a six-model,
eight-architecture bake-off on this class of problem.

## Why this shape

Plain vector RAG is strong on semantics but weak on exact ids and on "what depends
on X" questions. A pure agent loop is slow and brittle on small models. A pure
graph approach is good at structure but poor at open-ended lookup. The winning
design fuses their strengths:

- **Fused retrieval** (vector + BM25 + graph hop) beat plain RAG roughly 2:1 on
  citation quality and had the highest capability ceiling.
- **A hierarchical KG backbone** built from *structured* hierarchy (not inferred
  from prose) turns impact/dependency questions — the weakest category for every
  approach — into graph traversal instead of LLM guesswork.
- **A deterministic gate** removes the language model from the
  answer-vs-"not-in-the-data" decision, which is where small models hallucinate or
  over-refuse.

## Pipeline

```
                       ┌──────────────────────── ingestion (offline) ───────────────────────┐
  source data ──▶ adapters ──▶ Record stream ──▶ runner:
  (PLM / wiki /       (pluggable)                   • provenance-tag (source → tier)
   tickets / md /                                   • chunk + embed  → FTS5 + vector index
   csv / json tree)                                 • build KG: hierarchy backbone (PART_OF)
                                                       + typed edges + people
                                                     • precompute impact/dependency closures
                                                              │
                                                              ▼
                                                      one SQLite file
                                                              │
  ┌──────────────────────────── query (online) ───────────────┼───────────────────────────┐
  │                                                            ▼                            │
  │  question ─▶ FUSED RETRIEVAL ─────────────────────────────────────────────────┐        │
  │               • exact id match     ┐                                           │        │
  │               • BM25 (FTS5)        ├─ reciprocal-rank fusion ─▶ provenance      │        │
  │               • vector (sqlite-vec)│      + graph hop from the top anchors      │        │
  │               • graph hop          ┘                             weighting      │        │
  │                                                                     │           │        │
  │                                                                     ▼           │        │
  │                                                          top chunks (1/artifact)│        │
  │                                                                     │           │        │
  │                            DETERMINISTIC GATE ◀─────────────────────┘           │        │
  │                            (id anchor, term coverage → verdict)                 │        │
  │                              │                    │                             │        │
  │                 insufficient │                    │ sufficient / borderline     │        │
  │                              ▼                    ▼                             │        │
  │                     "not in corpus"      SYNTHESIS (LLM)                        │        │
  │                     + what was found     context = chunks + graph paths +       │        │
  │                                          closures → grounded answer with        │        │
  │                                          per-claim citations (→ exact spans)    │        │
  └────────────────────────────────────────────────────────────────────────────────────────┘
```

## Modules (`backend/hde/`)

| module | responsibility |
|---|---|
| `config.py` | environment-driven settings with offline defaults |
| `ingest/base.py` | the `SourceAdapter` / `Record` contract |
| `ingest/*_adapter.py` | markdown, json-tree, csv, and demo-corpus adapters |
| `ingest/runner.py` | parse → chunk → embed → graph → closures, one pass |
| `store.py` | the single-file SQLite schema (FTS5, vector, graph, closures) |
| `embeddings.py` | pluggable embedder (hash / ollama / sbert) |
| `llm.py` | pluggable answer model (mock / ollama / anthropic) |
| `provenance.py` | source → tier mapping and ranking weights |
| `chunking.py` | text → chunks with source-span offsets |
| `retrieval.py` | the fused retriever (exact + BM25 + vector + graph, RRF) |
| `graph.py` | knowledge-graph traversal (hierarchy walks, closures, neighbourhoods) |
| `gate.py` | the deterministic evidence-sufficiency gate |
| `synthesis.py` | context assembly + grounded generation + citation resolution |
| `engine.py` | the stateful facade the API and CLI sit on |
| `api/app.py` | the FastAPI application |

## The knowledge graph

Nodes are entities (parts/assemblies), documents (leaf artifacts), and people.
The backbone is the `PART_OF` hierarchy built from each entity's structured parent
link — real product-lifecycle systems hang every document off a part tree, so the
graph reflects genuine structure rather than something inferred from text.
Documents attach to the entities they describe via typed edges (`DESCRIBES`,
`MODIFIES`, `TRIGGERS`, `AFFECTS`, `AUTHORED_BY`, ...). Impact and dependency
questions are answered by traversing this graph and the closures precomputed at
ingest time, not by asking the model to reason over prose.

## The gate

The gate computes a handful of signals from the retrieval result — whether the
question names a record id that exists and was retrieved (the anchor), what
fraction of the question's content terms appear in the retrieved text (coverage),
and how concentrated the top scores are — and maps them to `sufficient`,
`borderline`, or `insufficient`. The decision is pure arithmetic, so it is stable
and auditable, and its numbers are surfaced directly in the UI as the confidence
display. Thresholds are calibrated on the demo corpus (see
`eval/calibrate_gate.py`) and lean toward answering: the failure mode being
engineered away is refusing real questions.

## Storage

Everything lives in one SQLite file: the lexical index (FTS5), the vector index
(`sqlite-vec`), the graph (`graph_nodes` / `graph_edges`), the precomputed
closures, and the ingestion history. There is no external database, search
service, or message broker to operate — `pip install` and run. Ingestion is
snapshot-only: re-ingesting a record id replaces any superseded version.

The corpus store is read-only at serve time. **Telemetry** (the request log and
thumbs feedback) is a *separate*, writable SQLite database (`HDE_TELEMETRY_DB`,
`hde/telemetry.py`) so the corpus store and the protected retrieval/gate/synthesis
core are never written to while serving. It is best-effort: a telemetry write can
never fail an answer, and in the container it lives on a named volume so it
survives image rebuilds.

## Serving concurrency

The engine shares one SQLite connection across the request threadpool, guarded by
a lock, because the SQLite handles aren't safe for concurrent use. That lock is
held **only** around the DB-touching phase — retrieval, the gate, and graph
expansion — and released before the answer model runs. This matters most for
streaming: the model call can take tens of seconds, and a client that abandons a
stream mid-generation (tab nav, reload) must not leave the lock held. Concurrent
generations simply queue at the model host (e.g. Ollama), not at our mutex.
