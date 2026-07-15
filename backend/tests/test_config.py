"""Config precedence: built-in defaults < config file (hde.toml) < environment."""
from __future__ import annotations

from hde.config import Settings
from hde.engine import Engine
from hde.ingest import Record, SourceAdapter, ingest


def _write(path, text):
    path.write_text(text)
    return path


def test_no_config_file_is_env_only_defaults(tmp_path, monkeypatch):
    # HDE_CONFIG pointing at a missing file -> falls through to built-in defaults.
    monkeypatch.setenv("HDE_CONFIG", str(tmp_path / "absent.toml"))
    for var in ("HDE_LLM_BACKEND", "HDE_SERVER_PORT"):
        monkeypatch.delenv(var, raising=False)
    s = Settings.load()
    assert s.llm_backend == "mock"
    assert s.server_port == 8000


def test_config_file_overrides_defaults(tmp_path, monkeypatch):
    cfg = _write(
        tmp_path / "hde.toml",
        """
        [llm]
        backend = "ollama"
        host = "http://work-ollama:11434"
        model = "gemma4:26b"
        num_predict = 4000

        [server]
        port = 9001
        cors_origins = ["https://app.internal"]

        [gate]
        cov_hi = 0.5
        """,
    )
    monkeypatch.setenv("HDE_CONFIG", str(cfg))
    for var in ("HDE_LLM_BACKEND", "HDE_LLM_MODEL", "HDE_SERVER_PORT", "HDE_GATE_COV_HI", "HDE_CORS_ORIGINS"):
        monkeypatch.delenv(var, raising=False)
    s = Settings.load()
    assert s.llm_backend == "ollama"
    assert s.ollama_llm_host == "http://work-ollama:11434"
    assert s.llm_model == "gemma4:26b"
    assert s.llm_num_predict == 4000
    assert s.server_port == 9001
    assert s.cors_origins == ("https://app.internal",)
    assert s.gate_cov_hi == 0.5


def test_env_overrides_config_file(tmp_path, monkeypatch):
    cfg = _write(
        tmp_path / "hde.toml",
        '[llm]\nbackend = "ollama"\nhost = "http://from-file:11434"\n[server]\nport = 9001\n',
    )
    monkeypatch.setenv("HDE_CONFIG", str(cfg))
    monkeypatch.setenv("HDE_LLM_BACKEND", "anthropic")  # env wins
    monkeypatch.setenv("HDE_SERVER_PORT", "9999")
    s = Settings.load()
    assert s.llm_backend == "anthropic"  # env over file
    assert s.server_port == 9999  # env over file
    assert s.ollama_llm_host == "http://from-file:11434"  # file kept where env absent


def test_config_file_corpus_branding_parsed(tmp_path, monkeypatch):
    cfg = _write(
        tmp_path / "hde.toml",
        """
        [corpus]
        id_pattern = "\\\\b\\\\d{4,8}\\\\b"
        title = "Widgets"
        placeholder = "Ask about widgets"
        starter_questions = [
          { text = "What is 000123?", hint = "lookup" },
          { text = "Impact of 000200?", hint = "impact" },
        ]
        """,
    )
    monkeypatch.setenv("HDE_CONFIG", str(cfg))
    monkeypatch.delenv("HDE_ID_PATTERN", raising=False)
    s = Settings.load()
    assert s.corpus_title == "Widgets"
    assert s.corpus_placeholder == "Ask about widgets"
    assert s.corpus_starter_questions == (("What is 000123?", "lookup"), ("Impact of 000200?", "impact"))
    assert s.id_pattern == r"\b\d{4,8}\b"


class _BareAdapter(SourceAdapter):
    source = "X"

    def records(self):
        yield Record("A-1", "document", "Thing One", "Some body text about a thing.", source="X")


def test_corpus_meta_falls_back_to_config_branding_when_db_absent(tmp_path):
    # The adapter declares no corpus_meta, so the config-file branding is used.
    settings = Settings(
        db_path=tmp_path / "d.db", telemetry_db=tmp_path / "t.db",
        embedder="hash", llm_backend="mock",
        corpus_title="ConfigCorp", corpus_placeholder="Ask ConfigCorp",
        corpus_starter_questions=(("Config Q", "ch"),),
    )
    ingest(_BareAdapter(), settings, reset=True)
    eng = Engine(settings)
    try:
        meta = eng.corpus_meta()
        assert meta["title"] == "ConfigCorp"
        assert meta["placeholder"] == "Ask ConfigCorp"
        assert meta["starter_questions"] == [{"text": "Config Q", "hint": "ch"}]
    finally:
        eng.close()
