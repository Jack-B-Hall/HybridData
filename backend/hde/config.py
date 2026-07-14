"""Environment-driven configuration for the hde engine.

Every knob has a safe offline default so `import hde` and `make demo` work with
zero configuration. Point the embedder and LLM at real backends via environment
variables when you want production-grade answers (see ``docs/deployment.md``).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Repository layout anchors. ``backend/hde/config.py`` -> repo root is two up.
PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PACKAGE_DIR.parent
REPO_ROOT = BACKEND_DIR.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    """Resolved settings snapshot. Construct with :meth:`from_env`."""

    # ── Storage ────────────────────────────────────────────────────────────
    db_path: Path = REPO_ROOT / "data" / "hde.db"

    # ── Embeddings ─────────────────────────────────────────────────────────
    # "hash"   deterministic, dependency-free (default; great for tests/CI)
    # "ollama" bge-m3 (or any embed model) over the Ollama HTTP API
    # "sbert"  a local sentence-transformers model
    embedder: str = "hash"
    embed_dim: int = 1024
    embed_model: str = "bge-m3"
    ollama_embed_host: str = "http://127.0.0.1:11434"
    sbert_model: str = "BAAI/bge-small-en-v1.5"

    # ── Answer model ───────────────────────────────────────────────────────
    # "mock"      deterministic, grounded, offline (default; used by tests + demo)
    # "ollama"    a local model (e.g. gemma-class) over the Ollama HTTP API
    # "anthropic" the Claude API via the anthropic SDK
    llm_backend: str = "mock"
    llm_model: str = "mock"
    ollama_llm_host: str = "http://127.0.0.1:11434"
    llm_timeout_s: int = 300
    llm_num_ctx: int = 16384

    # ── Retrieval / gate tuning ────────────────────────────────────────────
    top_chunks: int = 8
    rrf_k: int = 60
    graph_hops: int = 2

    # ── Misc ───────────────────────────────────────────────────────────────
    cors_origins: tuple[str, ...] = field(default_factory=lambda: ("*",))

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=Path(_env("HDE_DB_PATH", str(cls.db_path))),
            embedder=_env("HDE_EMBEDDER", cls.embedder),
            embed_dim=int(_env("HDE_EMBED_DIM", str(cls.embed_dim))),
            embed_model=_env("HDE_EMBED_MODEL", cls.embed_model),
            ollama_embed_host=_env("HDE_OLLAMA_EMBED_HOST", cls.ollama_embed_host),
            sbert_model=_env("HDE_SBERT_MODEL", cls.sbert_model),
            llm_backend=_env("HDE_LLM_BACKEND", cls.llm_backend),
            llm_model=_env("HDE_LLM_MODEL", cls.llm_model),
            ollama_llm_host=_env("HDE_OLLAMA_LLM_HOST", cls.ollama_llm_host),
            llm_timeout_s=int(_env("HDE_LLM_TIMEOUT_S", str(cls.llm_timeout_s))),
            llm_num_ctx=int(_env("HDE_LLM_NUM_CTX", str(cls.llm_num_ctx))),
            top_chunks=int(_env("HDE_TOP_CHUNKS", str(cls.top_chunks))),
            rrf_k=int(_env("HDE_RRF_K", str(cls.rrf_k))),
            graph_hops=int(_env("HDE_GRAPH_HOPS", str(cls.graph_hops))),
            cors_origins=tuple(
                o.strip() for o in _env("HDE_CORS_ORIGINS", "*").split(",") if o.strip()
            ),
        )


def get_settings() -> Settings:
    """Return a fresh settings snapshot resolved from the current environment."""
    return Settings.from_env()
