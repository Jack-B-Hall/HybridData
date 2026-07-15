# Hybrid-Data-Example — single self-contained image: FastAPI serves both the
# JSON API and the built single-page frontend from one origin. Runs fully
# offline (hash embedder + mock answer model), so no GPU and no network at run
# time. The demo SQLite store is baked in at build time for instant startup.

# ── Stage 1: build the frontend ─────────────────────────────────────────────
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: backend + built frontend ───────────────────────────────────────
FROM python:3.12-slim AS runtime
WORKDIR /app

# Editable install keeps the package at /app/backend/hde, so config.REPO_ROOT
# resolves to /app and the bundled demo corpus + default paths line up exactly
# as they do in a source checkout.
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e ./backend

# Demo corpus (the only data the offline `ingest --demo` reads) and the built SPA.
COPY data/demo-corpus/ ./data/demo-corpus/
COPY --from=frontend /app/frontend/dist/ ./frontend/dist/

# Offline defaults: hash embedder + mock answer model (no GPU, no network).
ENV HDE_EMBEDDER=hash \
    HDE_LLM_BACKEND=mock \
    HDE_DB_PATH=/app/data/hde.db \
    HDE_FRONTEND_DIST=/app/frontend/dist

# Bake the SQLite demo store into the image so the container starts instantly.
RUN hde ingest --demo

EXPOSE 8000
CMD ["hde", "serve", "--host", "0.0.0.0", "--port", "8000"]
