"""Shared fixtures.

``tiny_engine`` builds a small, self-contained store from a handful of records so
unit tests are fast and independent of the demo corpus. ``demo_engine`` uses the
bundled demo corpus if it has been ingested (``make demo``); tests that need it
skip cleanly when it is absent.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hde.config import REPO_ROOT, Settings
from hde.engine import Engine
from hde.ingest import Record, Relation, SourceAdapter, ingest


class _TinyAdapter(SourceAdapter):
    """A minimal assembly tree with a spec, a ticket, and a person."""

    def records(self):
        yield Record("A-1", "entity", "Widget Assembly", "The top-level widget assembly.",
                     source="PLM")
        yield Record("A-2", "entity", "Power Module", "The power module sub-assembly. Battery pack.",
                     source="PLM", parent_id="A-1", subsystem="Power")
        yield Record("A-3", "entity", "Frame", "The structural frame.",
                     source="PLM", parent_id="A-1", subsystem="Structure")
        yield Record(
            "D-1", "document", "Power Module Specification",
            "Specification for the power module. The battery pack chemistry is LiFePO4 "
            "for thermal safety. Approved by the chief engineer.",
            source="PLM", refs=["A-2"],
            relations=[Relation("DESCRIBES", "A-2"), Relation("AUTHORED_BY", "E-1")],
        )
        yield Record(
            "T-1", "document", "Battery overheating during test",
            "Ticket: the battery pack overheated during a thermal endurance test. "
            "Triggered a change request for the power module.",
            source="Jira", refs=["A-2", "D-1"],
        )
        yield Record("E-1", "person", "Chief Engineer",
                     "Chief Engineer — power systems.", source="PLM",
                     metadata={"status": "active"})


def _build(tmp_path: Path) -> Engine:
    settings = Settings(
        db_path=tmp_path / "tiny.db",
        telemetry_db=tmp_path / "telemetry.db",
        embedder="hash", llm_backend="mock",
    )
    ingest(_TinyAdapter(), settings, reset=True)
    return Engine(settings)


@pytest.fixture
def tiny_engine(tmp_path) -> Engine:
    eng = _build(tmp_path)
    yield eng
    eng.close()


@pytest.fixture
def demo_engine(tmp_path):
    db = REPO_ROOT / "data" / "hde.db"
    if not db.exists():
        pytest.skip("demo corpus not ingested (run `make demo`)")
    # Telemetry goes to a temp DB so the API tests never write into the repo.
    settings = Settings(
        db_path=db, telemetry_db=tmp_path / "telemetry.db",
        embedder="hash", llm_backend="mock",
    )
    eng = Engine(settings)
    yield eng
    eng.close()
