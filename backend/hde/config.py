"""Environment-driven configuration for the hde engine.

Every knob has a safe offline default so `import hde` and `make demo` work with
zero configuration. Point the embedder and LLM at real backends via environment
variables when you want production-grade answers (see ``docs/deployment.md``).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .ids import ID_PATTERN_DEFAULT

# Repository layout anchors. ``backend/hde/config.py`` -> repo root is two up.
PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PACKAGE_DIR.parent
REPO_ROOT = BACKEND_DIR.parent

# The gate's default domain-flavoured stopwords, split out from generic English so
# they can be overridden for a non-engineering corpus. The default set reproduces
# the original combined stoplist exactly (see hde.gate).
DEFAULT_DOMAIN_STOPWORDS = (
    "changing", "change", "changed", "changes", "affect", "affects", "affected",
    "requires", "require", "required", "system", "new",
)


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    """Resolved settings snapshot. Construct with :meth:`from_env`."""

    # ── Storage ────────────────────────────────────────────────────────────
    db_path: Path = REPO_ROOT / "data" / "hde.db"
    # Telemetry lives in a SEPARATE, writable database so the corpus store stays
    # read-only and the protected core is never written to at serve time. In the
    # container this is mounted on a named volume so it survives image rebuilds.
    telemetry_db: Path = REPO_ROOT / "data" / "telemetry.db"

    # Record-id shape used for exact-id retrieval, the gate's id anchor, and
    # citation grounding. Default = the demo's PREFIX-digits shape; override for a
    # corpus with different ids. Persisted in DB meta at ingest (query-time == ingest-time).
    id_pattern: str = ID_PATTERN_DEFAULT

    # ── Embeddings ─────────────────────────────────────────────────────────
    # "hash"   deterministic, dependency-free (default; great for tests/CI)
    # "ollama" nomic-embed-text (or any embed model) over the Ollama HTTP API;
    #          the dimension is discovered from the server automatically
    # "sbert"  a local sentence-transformers model
    embedder: str = "hash"
    embed_dim: int = 1024                       # used by the hash embedder only
    embed_model: str = "nomic-embed-text"       # Nomic AI (US); ollama embedder
    ollama_embed_host: str = "http://127.0.0.1:11434"
    sbert_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # ── Answer model ───────────────────────────────────────────────────────
    # "mock"      deterministic, grounded, offline (default; used by tests + demo)
    # "ollama"    a local model (e.g. gemma-class) over the Ollama HTTP API
    # "anthropic" the Claude API via the anthropic SDK
    llm_backend: str = "mock"
    llm_model: str = "mock"
    ollama_llm_host: str = "http://127.0.0.1:11434"
    llm_timeout_s: int = 300
    llm_num_ctx: int = 16384
    llm_think: bool = False        # enable reasoning-model chain-of-thought (slow)
    llm_num_predict: int = 1500    # max answer tokens for ollama

    # ── Retrieval / gate tuning ────────────────────────────────────────────
    top_chunks: int = 8
    rrf_k: int = 60
    graph_hops: int = 2

    # Gate answer/decline thresholds, calibrated on the demo corpus. Exposed so a
    # real-data deployment can recalibrate (see eval/calibrate_gate.py) without a
    # code change; defaults reproduce the original boundaries exactly.
    gate_cov_hi: float = 0.34
    gate_cov_mid: float = 0.20
    gate_cov_void: float = 0.20
    gate_strong_frac: float = 0.5
    # Domain-flavoured gate stopwords (added to the generic English stoplist).
    gate_domain_stopwords: tuple[str, ...] = field(default_factory=lambda: DEFAULT_DOMAIN_STOPWORDS)

    # ── Misc ───────────────────────────────────────────────────────────────
    cors_origins: tuple[str, ...] = field(default_factory=lambda: ("*",))

    # Built frontend to serve alongside the API. When this directory exists the
    # API also serves the single-page app (see hde.api.app); absent, the API is
    # headless. Defaults to the repo's frontend/dist so `npm run build` is enough.
    frontend_dist: Path = REPO_ROOT / "frontend" / "dist"

    @classmethod
    def from_env(cls) -> "Settings":
        domain_stop_env = os.environ.get("HDE_GATE_DOMAIN_STOPWORDS")
        domain_stopwords = (
            tuple(w.strip().lower() for w in domain_stop_env.split(",") if w.strip())
            if domain_stop_env is not None
            else DEFAULT_DOMAIN_STOPWORDS
        )
        return cls(
            db_path=Path(_env("HDE_DB_PATH", str(cls.db_path))),
            telemetry_db=Path(_env("HDE_TELEMETRY_DB", str(cls.telemetry_db))),
            id_pattern=_env("HDE_ID_PATTERN", ID_PATTERN_DEFAULT),
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
            llm_think=_env("HDE_LLM_THINK", "1" if cls.llm_think else "0") not in ("0", "false", ""),
            llm_num_predict=int(_env("HDE_LLM_NUM_PREDICT", str(cls.llm_num_predict))),
            top_chunks=int(_env("HDE_TOP_CHUNKS", str(cls.top_chunks))),
            rrf_k=int(_env("HDE_RRF_K", str(cls.rrf_k))),
            graph_hops=int(_env("HDE_GRAPH_HOPS", str(cls.graph_hops))),
            gate_cov_hi=float(_env("HDE_GATE_COV_HI", str(cls.gate_cov_hi))),
            gate_cov_mid=float(_env("HDE_GATE_COV_MID", str(cls.gate_cov_mid))),
            gate_cov_void=float(_env("HDE_GATE_COV_VOID", str(cls.gate_cov_void))),
            gate_strong_frac=float(_env("HDE_GATE_STRONG_FRAC", str(cls.gate_strong_frac))),
            gate_domain_stopwords=domain_stopwords,
            cors_origins=tuple(
                o.strip() for o in _env("HDE_CORS_ORIGINS", "*").split(",") if o.strip()
            ),
            frontend_dist=Path(_env("HDE_FRONTEND_DIST", str(cls.frontend_dist))),
        )


def get_settings() -> Settings:
    """Return a fresh settings snapshot resolved from the current environment."""
    return Settings.from_env()
