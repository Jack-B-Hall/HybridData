# HTTP API reference

The backend serves a small JSON API under `/api`. Start it with `hde serve`
(default `http://127.0.0.1:8000`); interactive docs are at `/docs`.

All responses are JSON. The serving workload is read-only; ingestion is done
out-of-band via the `hde ingest` CLI.

## Endpoints

### `GET /api/health`
Liveness and backend info.
```json
{ "status": "ok", "llm_backend": "mock/mock", "embedder": "hash", "db": "data/hde.db" }
```

### `POST /api/ask`
Body: `{ "question": string }`. Returns an `AskResult`:

| field | type | notes |
|---|---|---|
| `question` | string | echoed |
| `answered` | boolean | `false` when the gate declined |
| `verdict` | `"sufficient" \| "borderline" \| "insufficient"` | gate decision |
| `confidence` | `"high" \| "medium" \| "low"` | display mapping of the verdict |
| `answer` | string | markdown-ish prose with inline `[1] [2]` markers |
| `signals` | object | gate signals (see below) — drives the confidence display |
| `claims` | `Claim[]` | `{ text, citations: string[] }` |
| `citations` | `Citation[]` | ordered; `marker` is the inline `[n]` |
| `graph_paths` | string[] | `"A -REL-> B"` relationship strings |
| `sources` | `Source[]` | every retrieved chunk (the sources panel) |
| `latency_ms` | number | |
| `backend` | string | e.g. `mock/mock`, `ollama/gemma...` |
| `retrieval` | object | `{ fts_hits, vector_hits, graph_hits, anchors, fused_candidates }` |

`signals`: `{ id_anchor: bool, term_coverage: number (0..1), top_score: number,
n_strong: int, n_chunks: int, n_terms: int, question_ids: string[],
named_known: string[], named_retrieved: string[] }`.

`Citation`: `{ marker: number, artifact_id: string, title: string, source: string,
tier_label: "formal"|"unverified"|"informal", chunk_idx: number,
char_start: number, char_end: number, passage: string, grounded: boolean }`.
The `passage` is the exact chunk text that grounded the claim; `char_start/end`
index into the source document's `text` so the viewer can highlight it.

`Source`: `{ rowid, artifact_id, source, art_kind, title, prov_tier, tier_label,
chunk_idx, char_start, char_end, body, score, legs: string[] }`. `legs` names
which retrievers found the chunk (`fts`, `vector`, `graph`).

When `answered` is `false`, `answer` is a refusal message and `sources` still
lists what *was* found — render this as a distinct "not in the corpus" state.

### `GET /api/documents`
Query params (all optional): `kind` (`entity|document|person`), `source`,
`subsystem`, `query` (substring over id/title), `limit` (1..1000, default 200).
```json
{ "count": 40, "documents": [
  { "id": "DOC-401", "kind": "document", "title": "...", "source": "PLM",
    "prov_tier": 1, "tier_label": "formal", "subsystem": "Systems" } ] }
```

### `GET /api/documents/{id}`
Full record. `404` if unknown.
```json
{ "id": "ECR-214", "kind": "document", "title": "...", "text": "...full text...",
  "source": "PLM", "prov_tier": 1, "tier_label": "formal", "subsystem": null,
  "parent_id": null, "metadata": { ... },
  "sections": [ { "chunk_idx": 0, "char_start": 0, "char_end": 1723, "body": "..." } ],
  "refs": ["P-1062", "..."], "referenced_by": ["ECN-312", "..."],
  "closure": { "artifact_id", "title", "prov_tier", "downstream_ids": [...],
               "upstream_ids": [...], "summary": "..." } }
```

### `GET /api/graph/overview`
`limit` (1..2000, default 400). A capped whole-graph view.
```json
{ "nodes": [ { "id", "kind", "label", "subsystem", "source", "prov_tier" } ],
  "edges": [ { "src", "dst", "rel" } ],
  "stats": { "nodes", "edges", "nodes_by_kind": {...}, "edges_by_rel": {...} } }
```

### `GET /api/graph/node/{id}`
`hops` (1..3, default 1). Neighbourhood subgraph. `404` if unknown.
```json
{ "center": "P-1062",
  "nodes": [ { "id", "kind", "label", "subsystem", "source", "prov_tier" } ],
  "edges": [ { "src", "dst", "rel" } ] }
```

### `GET /api/corpus/stats`
```json
{ "totals": { "artifacts", "chunks", "refs" },
  "by_kind": {...}, "by_source": {...}, "by_tier": {...}, "by_subsystem": {...},
  "graph": { "nodes", "edges", "nodes_by_kind", "edges_by_rel" },
  "embedder": "hash", "snapshot_at": "2026-..." }
```

### `GET /api/ingest/history`
```json
{ "runs": [ { "id", "started_at", "finished_at", "adapter", "source_path",
  "n_records", "n_chunks", "n_nodes", "n_edges", "status", "note" } ] }
```

Representative real responses for every endpoint are committed under
`frontend/src/mocks/fixtures/` and are used by the frontend's mocks and e2e tests.
