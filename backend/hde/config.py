"""Configuration for the hde engine.

Every knob has a safe offline default so `import hde` and `make demo` work with
zero configuration. Deployment-specific values (Ollama host, model names, db paths,
gate tuning, corpus branding) resolve from three layers, lowest to highest:

    1. built-in defaults (this file)
    2. a config file  (``hde.toml`` — ``HDE_CONFIG`` env, else ``./hde.toml``)
    3. environment variables  (``HDE_*``)

So `hde.toml` is the one place to edit when transplanting to a work environment,
and any single value can still be overridden by an env var. With no file present,
behaviour is exactly the env-only behaviour it always had. See
``hde.example.toml`` and ``docs/deployment.md``.
"""
from __future__ import annotations

import os
import tomllib
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


@dataclass(frozen=True)
class Settings:
    """Resolved settings snapshot. Construct with :meth:`load` (or :meth:`from_env`)."""

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

    # ── Server ─────────────────────────────────────────────────────────────
    server_port: int = 8000
    cors_origins: tuple[str, ...] = field(default_factory=lambda: ("*",))

    # Built frontend to serve alongside the API. When this directory exists the
    # API also serves the single-page app (see hde.api.app); absent, the API is
    # headless. Defaults to the repo's frontend/dist so `npm run build` is enough.
    frontend_dist: Path = REPO_ROOT / "frontend" / "dist"

    # ── Corpus branding (config-file alternative to adapter/DB corpus_meta) ──
    # When a store was ingested with adapter-declared corpus_meta, that wins; these
    # let a deployment set branding purely from the config file instead.
    corpus_title: str | None = None
    corpus_placeholder: str | None = None
    corpus_starter_questions: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    # App branding: the header title/browser tab and the header glyph + favicon.
    # app_icon is an emoji (rendered + used as an SVG-text favicon) or a path/URL to
    # an image. None -> the built-in name + mark. Adapter/DB corpus_meta still wins.
    corpus_app_name: str | None = None
    corpus_app_icon: str | None = None

    @classmethod
    def load(cls) -> "Settings":
        """Resolve settings from defaults < config file < environment variables."""
        f = _read_config_file()

        def fv(section: str, key: str):
            return f.get(section, {}).get(key)

        domain_stopwords = _pick_words(
            "HDE_GATE_DOMAIN_STOPWORDS", fv("gate", "domain_stopwords"), DEFAULT_DOMAIN_STOPWORDS
        )
        cors = _pick_words("HDE_CORS_ORIGINS", fv("server", "cors_origins"), ("*",), lower=False)
        starters = _read_starters(fv("corpus", "starter_questions"))

        return cls(
            db_path=_pick_path("HDE_DB_PATH", fv("storage", "db_path"), cls.db_path),
            telemetry_db=_pick_path("HDE_TELEMETRY_DB", fv("storage", "telemetry_db"), cls.telemetry_db),
            id_pattern=_pick_str("HDE_ID_PATTERN", fv("corpus", "id_pattern"), ID_PATTERN_DEFAULT),
            embedder=_pick_str("HDE_EMBEDDER", fv("embedder", "backend"), cls.embedder),
            embed_dim=_pick_int("HDE_EMBED_DIM", fv("embedder", "dim"), cls.embed_dim),
            embed_model=_pick_str("HDE_EMBED_MODEL", fv("embedder", "model"), cls.embed_model),
            ollama_embed_host=_pick_str("HDE_OLLAMA_EMBED_HOST", fv("embedder", "host"), cls.ollama_embed_host),
            sbert_model=_pick_str("HDE_SBERT_MODEL", fv("embedder", "sbert_model"), cls.sbert_model),
            llm_backend=_pick_str("HDE_LLM_BACKEND", fv("llm", "backend"), cls.llm_backend),
            llm_model=_pick_str("HDE_LLM_MODEL", fv("llm", "model"), cls.llm_model),
            ollama_llm_host=_pick_str("HDE_OLLAMA_LLM_HOST", fv("llm", "host"), cls.ollama_llm_host),
            llm_timeout_s=_pick_int("HDE_LLM_TIMEOUT_S", fv("llm", "timeout_s"), cls.llm_timeout_s),
            llm_num_ctx=_pick_int("HDE_LLM_NUM_CTX", fv("llm", "num_ctx"), cls.llm_num_ctx),
            llm_think=_pick_bool("HDE_LLM_THINK", fv("llm", "think"), cls.llm_think),
            llm_num_predict=_pick_int("HDE_LLM_NUM_PREDICT", fv("llm", "num_predict"), cls.llm_num_predict),
            top_chunks=_pick_int("HDE_TOP_CHUNKS", fv("retrieval", "top_chunks"), cls.top_chunks),
            rrf_k=_pick_int("HDE_RRF_K", fv("retrieval", "rrf_k"), cls.rrf_k),
            graph_hops=_pick_int("HDE_GRAPH_HOPS", fv("retrieval", "graph_hops"), cls.graph_hops),
            gate_cov_hi=_pick_float("HDE_GATE_COV_HI", fv("gate", "cov_hi"), cls.gate_cov_hi),
            gate_cov_mid=_pick_float("HDE_GATE_COV_MID", fv("gate", "cov_mid"), cls.gate_cov_mid),
            gate_cov_void=_pick_float("HDE_GATE_COV_VOID", fv("gate", "cov_void"), cls.gate_cov_void),
            gate_strong_frac=_pick_float("HDE_GATE_STRONG_FRAC", fv("gate", "strong_frac"), cls.gate_strong_frac),
            gate_domain_stopwords=domain_stopwords,
            server_port=_pick_int("HDE_SERVER_PORT", fv("server", "port"), cls.server_port),
            cors_origins=cors,
            frontend_dist=_pick_path("HDE_FRONTEND_DIST", fv("server", "frontend_dist"), cls.frontend_dist),
            corpus_title=_pick_optional("HDE_CORPUS_TITLE", fv("corpus", "title"), None),
            corpus_placeholder=_pick_optional("HDE_CORPUS_PLACEHOLDER", fv("corpus", "placeholder"), None),
            corpus_starter_questions=starters,
            corpus_app_name=_pick_optional("HDE_CORPUS_APP_NAME", fv("corpus", "app_name"), None),
            corpus_app_icon=_pick_optional("HDE_CORPUS_APP_ICON", fv("corpus", "app_icon"), None),
        )

    # Backwards-compatible alias (env + file layering happens either way).
    from_env = load


def _config_path() -> Path | None:
    explicit = os.environ.get("HDE_CONFIG")
    if explicit:
        return Path(explicit)
    default = Path.cwd() / "hde.toml"
    return default if default.is_file() else None


def _read_config_file() -> dict:
    path = _config_path()
    if not path or not path.is_file():
        return {}
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _pick_str(env: str, fileval, default: str) -> str:
    v = os.environ.get(env)
    if v is not None:
        return v
    return str(fileval) if fileval is not None else default


def _pick_optional(env: str, fileval, default):
    v = os.environ.get(env)
    if v is not None:
        return v
    return fileval if fileval is not None else default


def _pick_int(env: str, fileval, default: int) -> int:
    v = os.environ.get(env)
    if v is not None:
        return int(v)
    return int(fileval) if fileval is not None else default


def _pick_float(env: str, fileval, default: float) -> float:
    v = os.environ.get(env)
    if v is not None:
        return float(v)
    return float(fileval) if fileval is not None else default


def _pick_bool(env: str, fileval, default: bool) -> bool:
    v = os.environ.get(env)
    if v is not None:
        return v not in ("0", "false", "")
    return bool(fileval) if fileval is not None else default


def _pick_path(env: str, fileval, default: Path) -> Path:
    v = os.environ.get(env)
    if v is not None:
        return Path(v)
    return Path(fileval) if fileval is not None else default


def _pick_words(env: str, fileval, default: tuple[str, ...], *, lower: bool = True) -> tuple[str, ...]:
    """Comma-separated env, or a TOML list, or the default tuple."""
    v = os.environ.get(env)
    if v is not None:
        items = [w.strip() for w in v.split(",") if w.strip()]
    elif fileval is not None:
        items = [str(w).strip() for w in fileval if str(w).strip()]
    else:
        return default
    return tuple(w.lower() for w in items) if lower else tuple(items)


def _read_starters(fileval) -> tuple[tuple[str, str], ...]:
    if not fileval:
        return ()
    out: list[tuple[str, str]] = []
    for q in fileval:
        if isinstance(q, dict) and q.get("text"):
            out.append((str(q["text"]), str(q.get("hint", ""))))
    return tuple(out)


def get_settings() -> Settings:
    """Return a fresh settings snapshot (defaults < config file < environment)."""
    return Settings.load()
