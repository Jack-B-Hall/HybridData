# Hybrid-Data-Example — developer tasks.
# Everything defaults to the offline stack (hash embedder + mock LLM), so these
# targets need no GPU and no network.

VENV := .venv
PY := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
HDE := $(VENV)/bin/hde
export HDE_DB_PATH := $(CURDIR)/data/hde.db

.DEFAULT_GOAL := help
# Live config (nomic-embed-text embeddings + a real local answer model). Copy
# .env.live.example -> .env.live and edit host/model; the *-live targets load it.
LIVE_ENV := .env.live

.PHONY: help venv install demo ingest serve api-only frontend-install frontend dev \
        test test-backend test-frontend e2e eval calibrate clean audit \
        ingest-live serve-live demo-live

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

venv: ## Create the Python virtualenv
	python3 -m venv $(VENV)

install: venv ## Install the backend package (editable) + dev extras
	$(PIP) install -q -e "./backend[dev]"

demo: install ## Ingest the demo corpus and launch the API + frontend (offline)
	$(HDE) ingest --demo
	@echo "\nDemo store built. Starting API (:8000) and frontend (:5173)..."
	@$(MAKE) -j2 api-only frontend

ingest: ## (Re)build the demo store only
	$(HDE) ingest --demo

serve: ## Alias for api-only
	@$(MAKE) api-only

api-only: ## Run the backend API on :8000
	$(HDE) serve --host 127.0.0.1 --port 8000

frontend-install: ## Install frontend dependencies
	cd frontend && npm install

frontend: frontend-install ## Run the frontend dev server on :5173
	cd frontend && npm run dev

# ── Live backends (real nomic-embed-text embeddings + a real answer model) ──────────────
ingest-live: install ## Ingest the demo corpus using the live config (.env.live)
	@test -f $(LIVE_ENV) || (echo "Missing $(LIVE_ENV) — copy .env.live.example and edit it"; exit 1)
	set -a; . ./$(LIVE_ENV); set +a; $(HDE) ingest --demo

serve-live: ## Run the API against the live config (.env.live)
	@test -f $(LIVE_ENV) || (echo "Missing $(LIVE_ENV) — copy .env.live.example and edit it"; exit 1)
	set -a; . ./$(LIVE_ENV); set +a; $(HDE) serve --host 127.0.0.1 --port 8000

demo-live: ingest-live ## Ingest (live config) then launch the live API + frontend
	@echo "\nLive store built. Starting live API (:8000) and frontend (:5173)..."
	@$(MAKE) -j2 serve-live frontend

test: test-backend test-frontend ## Run all unit tests

test-backend: ## Run backend pytest suite
	cd backend && ../$(PY) -m pytest -q

test-frontend: ## Run frontend vitest suite
	cd frontend && npm run test -- --run

e2e: ## Run Playwright end-to-end tests (mocked backend)
	cd frontend && npm run test:e2e

eval: ## Run the evaluation harness over the gold question set
	$(PY) eval/run_eval.py

calibrate: ## Print gate signal distributions for tuning
	$(PY) eval/calibrate_gate.py

audit: ## Prove the repo is free of the banned upstream project names
	@bash scripts/audit.sh

clean: ## Remove the runtime store and caches
	rm -f data/hde.db data/hde.db-wal data/hde.db-shm
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
