# Deployment

The system is deliberately small to operate: one SQLite file, one Python API
process, and one static frontend bundle. There is no external database, vector
service, or message broker.

## Backends

Two things are pluggable; both default to offline stand-ins so nothing is required
to get started.

### Embedder (`HDE_EMBEDDER`)

| value | what it is | when to use |
|---|---|---|
| `hash` (default) | deterministic hashing embedder, no deps | tests, CI, offline demo |
| `ollama` | nomic-embed-text (or any embed model) via a local Ollama server | **recommended for production** |
| `sbert` | an in-process sentence-transformers model (default all-MiniLM-L6-v2) | in-process, no sidecar |

For `ollama`: `HDE_OLLAMA_EMBED_HOST` (default `http://127.0.0.1:11434`) and
`HDE_EMBED_MODEL` (default `nomic-embed-text`). The output dimension is discovered
from the server automatically, so no size needs configuring. Keep the embedder
identical between ingest and query. Embeddings never leave the host, so document
content stays on-site.

The reference stack is intentionally **western-origin** (Google gemma answer model,
Nomic AI / US sentence-transformers embedders, optional Anthropic API) so it is
deployable in restricted and sovereign environments with model-provenance
requirements. Any Ollama- or SDK-served model works if your environment permits it.

### Answer model (`HDE_LLM_BACKEND`)

| value | what it is |
|---|---|
| `mock` (default) | deterministic, grounded, offline — for tests and the demo |
| `ollama` | a local model (e.g. a gemma-class 12-27B) via Ollama |
| `anthropic` | the Claude API via the official SDK (`pip install 'hde[anthropic]'`) |

For `ollama`: `HDE_OLLAMA_LLM_HOST`, `HDE_LLM_MODEL` (e.g. `gemma3:12b`). For
`anthropic`: set `HDE_LLM_MODEL` and the SDK's standard `ANTHROPIC_API_KEY`.

## GPU sizing

Retrieval, the graph, and the gate run comfortably on CPU. The GPU cost is the
answer model. The architecture targets a **single 16-32 GB GPU** running a
gemma-class model:

- **16 GB** (e.g. a 16 GB consumer card): a ~12B model quantised, or a
  fast mixture-of-experts variant, plus nomic-embed-text embeddings. Good throughput.
- **24-32 GB**: a ~27-31B model with partial offload for the best answer quality
  short of a frontier API.

Embeddings (nomic-embed-text) need well under 1 GB and can share the card or run on
CPU. If you use the `anthropic` answer backend, no local GPU is needed at all.

## Running the API

```bash
pip install ./backend                 # or: pip install 'hde[anthropic]'
HDE_DB_PATH=/srv/hde/hde.db hde ingest --demo        # or your own adapters
HDE_EMBEDDER=ollama HDE_LLM_BACKEND=ollama HDE_LLM_MODEL=gemma3:12b \
  hde serve --host 0.0.0.0 --port 8000
```

For a ready-made "live" config (nomic-embed-text embeddings + a gemma-class answer
model), copy `.env.live.example` to `.env.live`, edit the host/model, and use the
convenience targets:

```bash
cp .env.live.example .env.live        # then edit HDE_OLLAMA_LLM_HOST / HDE_LLM_MODEL
make demo-live                        # ingest with nomic-embed-text + serve the live model + frontend
```

`make demo-live` keeps its store separate (`data/hde-live.db`) so the offline
`make demo` stays reproducible.

The API opens the SQLite store once and shares it across the request threadpool
under a lock (the serving workload is read-only). Put it behind your usual reverse
proxy for TLS. Restrict CORS in production with `HDE_CORS_ORIGINS`
(comma-separated), rather than the permissive default.

## Building the frontend

```bash
cd frontend
npm install
npm run build            # emits static assets in frontend/dist/
```

Serve `frontend/dist/` from any static host and point it at the API (the frontend
calls `/api`; configure your proxy so `/api` reaches the backend, or set the API
base at build time).

## Re-ingesting / updating

Ingestion is snapshot-only. Re-run `hde ingest` to rebuild from scratch
(`reset=True`), or ingest with `--append` to replace individual records by id
without a full rebuild. The `ingest_runs` table records the history, surfaced in
the Data Explorer's analytics view.

## Operational notes

- The store is a single file: back it up by copying it (use SQLite's backup API or
  copy while the writer is idle). WAL side-files (`-wal`, `-shm`) are transient.
- All processing is deterministic given a fixed embedder and answer model, which
  makes staging/production parity and debugging straightforward.
