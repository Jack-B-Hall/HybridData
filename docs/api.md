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

### `POST /api/ask/stream`
Same body as `/api/ask`, but streams the pipeline as **Server-Sent Events**
(`Content-Type: text/event-stream`) so the UI can show staged progress and the
answer as it is generated. Each event is one `data:` frame carrying a JSON object
with a `type`:

| `type` | payload | emitted |
|---|---|---|
| `retrieval` | `{ answered, verdict, confidence, signals, backend, sources, graph_paths, retrieval }` | once, as soon as retrieval + the gate have run (before generation) |
| `token` | `{ text }` | zero or more; a newly-displayable slice of answer prose (answerable case only) |
| `done` | `{ result }` | once; `result` is the full `AskResult` above, with citations resolved and timing |
| `error` | `{ message }` | on failure, in place of `done` |

The concatenated `token` texts reassemble the streamed prose; the authoritative,
citation-resolved answer is always the `done` event's `result`. A declined
(`answered: false`) question emits no `token` events. The blocking `/api/ask`
endpoint is unchanged and remains the simplest way to get a single JSON result.

Every ask (blocking or streamed) is logged to a separate, writable telemetry
database (`HDE_TELEMETRY_DB`, never the read-only corpus store). The response
carries an `ask_id`; feedback attaches to it. Streams are logged on `done`, and
also on error or client disconnect (`status` = `error` / `abandoned`), so
abandoned streams are visible in system health.

### Multi-turn chat (conversations)

The Chat tab's API (design in [chat.md](chat.md)). Conversations persist in the
writable telemetry DB; every turn condenses the message + recent history into a
standalone question, then runs the same retrieve -> gate -> synthesize pipeline
as `/api/ask` against it.

#### `POST /api/chat/conversations` → `201`
Create a conversation. Body: `{ "title": string? }` (untitled conversations
inherit their first message as a display title). Returns
`{ id, created_at, updated_at, title, n_turns }`.

#### `GET /api/chat/conversations?limit=100`
`{ "conversations": [ { id, created_at, updated_at, title, n_turns }, ... ] }`,
newest activity first.

#### `GET /api/chat/conversations/{id}`
One conversation plus its `turns`, oldest first. Each turn:

```
{ "id", "conversation_id", "ts",
  "message": string,             // the raw user message
  "rewritten": string,           // the condensed standalone question retrieval ran on
  "rewrite_method": "raw" | "llm" | "mock",
  "ask_id": number,              // the telemetry asks row (feedback attaches here)
  "answered", "verdict", "confidence", "answer", "cited_ids",
  "result": AskResult,           // full payload: citations, sources, signals, ...
  "latency_ms", "backend", "status": "ok" | "error", "error" }
```

#### `PATCH /api/chat/conversations/{id}`
Rename: `{ "title": string }`. `DELETE` removes the conversation and its turns.
Both 404 on an unknown id.

#### `POST /api/chat/conversations/{id}/messages`
Run one blocking turn. Body: `{ "message": string }` (1 to 1000 chars). Returns
the persisted turn above. An answer-model failure returns a clean `502` for
that turn only; the conversation remains usable.

#### `POST /api/chat/conversations/{id}/messages/stream`
The SSE variant, mirroring `/api/ask/stream` with one extra leading event:

| `type` | payload | emitted |
|---|---|---|
| `rewrite` | `{ conversation_id, message, rewritten, rewrite_method }` | once, before retrieval |
| `retrieval` | as `/api/ask/stream` | once |
| `token` | `{ text }` | zero or more (answerable turns only) |
| `done` | `{ turn }` (the persisted turn) | once |
| `error` | `{ message }` | on failure, in place of `done` |

### `POST /api/feedback`
Attach thumbs feedback to a logged ask. Body:

| field | type | notes |
|---|---|---|
| `ask_id` | number | the `ask_id` from an `AskResult` (≥ 1) |
| `rating` | `"up" \| "down"` | validated; other values → 422 |
| `comment` | string? | optional, ≤ 2000 chars (typically sent with a down) |

Returns `{ "ok": true, "feedback_id": number }`, or 404 if `ask_id` is unknown.

### `GET /api/telemetry/health`
System-health metrics for the Data Explorer. Query param `recent` (1–200,
default 25) caps the recent-questions slice. Returns:

```
{ "totals":   { "asks", "answered", "refused", "errors", "abandoned" },
  "answer_rate": number,                       // answered / (answered+refused)
  "latency":   { "p50_ms", "p95_ms" },         // over status='ok' asks
  "feedback":  { "up", "down", "ratio" },      // ratio = up / (up+down)
  "per_day":   [ { "day": "YYYY-MM-DD", "count": number }, ... ],
  "recent":    [ { "id", "ts", "question", "verdict", "confidence",
                   "answered", "latency_ms", "status", "streamed",
                   "feedback": "up"|"down"|null }, ... ] }
```

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

### `POST /api/ingest/start`
Start a corpus job. One runs at a time; the slow rebuild happens in a temp store
and only the final file-swap holds the engine lock, so the app keeps answering
from the current store while a job runs.
```json
// request
{ "action": "reingest" | "scan" | "clear",
  "confirm": "CLEAR" }   // required only for action "clear"
```
- `reingest` — rebuild the whole store from the configured `[ingest]` sources.
- `scan` — re-read the sources and report added / updated / removed records
  (content-hash diff), then swap in the refreshed store.
- `clear` — wipe the corpus store (telemetry/history are kept). Needs
  `confirm: "CLEAR"` so it can't fire by accident.

Returns the job status (same shape as `GET /api/ingest/status`). Responds
`409` if a job is already running, `422` for an unknown action or a `clear`
without the confirm token.

### `GET /api/ingest/status`
Current or most-recent job. `counts` is populated once a job finishes.
```json
{ "running": true, "action": "scan", "stage": "embedding chunks…",
  "started_at": "2026-07-15T12:40:03+00:00", "finished_at": null,
  "status": null, "error": null,
  "counts": { "records", "chunks", "nodes", "edges", "added", "updated", "removed" } }
```
`stage` is a human-readable progress string; `status` becomes `"ok"` or
`"error"` (with `error` set) when `running` returns to `false`.

### `GET /api/ingest/jobs?limit=25`
Persistent run history, newest first. Lives in the telemetry DB, so it survives
corpus rebuilds and clears. Datetimes are ISO-8601 UTC; the UI renders them in
local time.
```json
{ "jobs": [ { "id", "started_at", "finished_at", "action", "source", "status",
  "n_records", "n_chunks", "n_nodes", "n_edges",
  "n_added", "n_updated", "n_removed", "duration_ms", "error" } ] }
```

### `GET /api/ingest/history`
```json
{ "runs": [ { "id", "started_at", "finished_at", "adapter", "source_path",
  "n_records", "n_chunks", "n_nodes", "n_edges", "status", "note" } ] }
```

### Testing (golden set + health test runs)

A curated golden set of questions, asked through the live engine and scored on two
axes combined into one composite score, run as a background job. The golden set and
run history live in the telemetry DB, so they survive corpus clears/rebuilds. On
first run the golden set is seeded from the bundled demo gold file (with reference
`golden_answer`s); negative (out-of-scope) questions seed as `behaviour: "refuse"`.

**Scoring** (see also `GET /api/testing/config` and `docs/deployment.md`):
- **Retrieval sub-score** (deterministic, 0-1) — behaviour correct (answered vs
  refused), expected citation artifact-ids present, expected keywords present.
- **Answer quality** — when a `golden_answer` is present and a judge is available,
  an LLM-as-judge scores the produced answer against the golden answer + retrieved
  evidence on a rubric: correctness, groundedness, completeness, citation quality
  (each 0-1) plus a short justification, returned as structured JSON.
- **Composite (0-100)** — a weighted blend of the retrieval sub-score and the
  judge's correctness/groundedness/completeness. With no golden answer or no judge,
  it degrades to the retrieval sub-score alone. A question passes at composite ≥
  the configured threshold (default 60).

#### `GET /api/testing/config`
The scoring methodology, so the UI renders it transparently.
```json
{ "pass_threshold": 60.0,
  "weights": { "retrieval": 0.30, "correctness": 0.40, "groundedness": 0.20, "completeness": 0.10 },
  "rubric_dims": ["correctness", "groundedness", "completeness", "citation_quality"],
  "judge": { "backend": "ollama", "model": "gemma4:26b-a4b-it-qat", "same_as_answer_model": true } }
```
`same_as_answer_model` is `true` when the judge reuses the answer model — a
self-judging bias that inflates scores, surfaced in the UI so it isn't mistaken for
an independent assessment.

#### `GET /api/testing/questions?category=&behaviour=&enabled=`
```json
{ "count": 40, "questions": [ { "id", "text", "category", "behaviour",
  "citations": [], "keywords": [], "golden_answer", "enabled": true, "notes",
  "created_at", "updated_at" } ] }
```

#### `POST /api/testing/questions` → `201`
```json
// request (only `text` is required)
{ "text", "category": "general", "behaviour": "answer",
  "citations": [], "keywords": [], "golden_answer": null, "enabled": true, "notes": null }
```
Returns the created question. `PATCH /api/testing/questions/{id}` updates any subset
of those fields (404 if unknown); `DELETE /api/testing/questions/{id}` removes it
(404 if unknown).

#### `POST /api/testing/run`
Kick a background run over the enabled golden set (optionally a category subset).
One at a time (`409` if a run is in progress); fire-and-forget. Returns the run
status (same shape as `GET /api/testing/run/status`).
```json
{ "categories": ["impact", "lookup"] }   // omit or empty = all enabled
```
If the answer backend (or a separate judge backend) is unreachable, the run ends
cleanly with `status: "error"` and a message — it never hangs.

#### `GET /api/testing/run/status`
```json
{ "running": true, "stage": "judging 12/40", "started_at", "finished_at": null,
  "status": null, "error": null, "total": 40, "done": 11, "passed": 9,
  "failed": 2, "run_id": null }
```

#### `GET /api/testing/runs?limit=25`
Persistent run history, newest first.
```json
{ "runs": [ { "id", "started_at", "finished_at", "status", "backend", "judge_backend",
  "scope", "total", "passed", "failed", "answer_rate", "refusal_rate",
  "mean_composite", "mean_latency_ms", "duration_ms", "error" } ] }
```

#### `GET /api/testing/runs/{id}`
One run's summary plus its per-question results (404 if unknown).
```json
{ "id", ..., "mean_composite", "results": [ { "id", "question_id", "question",
  "category", "behaviour", "answered", "verdict", "passed", "failed_checks": [],
  "retrieval_score", "judged", "judge_correctness", "judge_groundedness",
  "judge_completeness", "judge_citation", "judge_justification", "composite",
  "latency_ms", "error" } ] }
```

Representative real responses for every endpoint are committed under
`frontend/src/mocks/fixtures/` and are used by the frontend's mocks and e2e tests.
