"""Adapter for the bundled demo corpus.

The demo corpus is a directory of typed JSON artifacts modelled on a product
lifecycle system: a parts/assembly tree plus the documents, change notices,
tickets, drawings, reviews and source modules that hang off it. This adapter
turns that into normalised records:

* parts become **entity** records, wired into an assembly hierarchy via
  ``structured.parent_id`` — this is the structural backbone finding #2 calls for;
* everything else becomes a **document** record;
* ``people.json`` becomes **person** records;
* cross-references become typed graph relations (MODIFIES, TRIGGERS, DESCRIBES,
  ...) plus authorship edges derived deterministically from structured metadata —
  no LLM is used at ingest time, so the graph is fully reproducible.

It doubles as a worked example of a non-trivial adapter (see
``docs/adding-a-data-source.md``).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterator

from .base import Record, Relation, SourceAdapter

_PERSON_ID = re.compile(r"^E\d+$")

# artifact type -> id prefix, used to type reference edges by (src_type, tgt_type)
_PREFIX_TYPE = {
    "P": "part", "ECR": "ecr", "ECN": "ecn", "DOC": "doc", "KES": "jira",
    "WIKI": "wiki", "SRC": "src", "DRW": "drawing", "REV": "review",
}

# (source_type, target_type) -> typed relation. Anything unlisted -> REFERENCES.
_EDGE_TYPE = {
    ("ecn", "ecr"): "IMPLEMENTS",
    ("ecn", "part"): "MODIFIES",
    ("ecn", "doc"): "UPDATES",
    ("ecr", "part"): "AFFECTS",
    ("ecr", "doc"): "AFFECTS",
    ("ecr", "jira"): "TRIGGERED_BY",
    ("ecr", "ecn"): "IMPLEMENTED_BY",
    ("drawing", "part"): "DEPICTS",
    ("review", "doc"): "REVIEWS",
    ("src", "jira"): "FIXES",
    ("src", "doc"): "IMPLEMENTS",
    ("jira", "ecr"): "TRIGGERS",
    ("jira", "ecn"): "CLOSED_BY",
    ("jira", "jira"): "LINKS_TO",
    ("jira", "part"): "AFFECTS",
    ("doc", "part"): "DESCRIBES",
}

# structured metadata field -> authorship relation to a person id.
_PERSON_FIELDS = {
    "author": "AUTHORED_BY",
    "primary_author": "AUTHORED_BY",
    "created_by": "AUTHORED_BY",
    "reporter": "REPORTED_BY",
    "assignee": "ASSIGNED_TO",
    "raised_by": "RAISED_BY",
    "approved_by": "APPROVED_BY",
    "approver": "APPROVED_BY",
    "drawn_by": "DRAWN_BY",
    "checked_by": "CHECKED_BY",
    "reviewer": "REVIEWED_BY",
    "last_modified_by": "MODIFIED_BY",
}

_TYPE_DIRS = ["parts", "ecr", "ecn", "docs", "jira", "wiki", "src", "drawings", "reviews"]


def _type_of(artifact_id: str) -> str:
    return _PREFIX_TYPE.get(artifact_id.split("-")[0], "unknown")


class JsonCorpusAdapter(SourceAdapter):
    """Reads the bundled demo corpus directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def records(self) -> Iterator[Record]:
        yield from self._people()
        for subdir in _TYPE_DIRS:
            d = self.root / subdir
            if not d.exists():
                continue
            for path in sorted(d.glob("*.json")):
                yield self._artifact(json.loads(path.read_text()))

    def _people(self) -> Iterator[Record]:
        path = self.root / "people.json"
        if not path.exists():
            return
        for p in json.loads(path.read_text()):
            status = p.get("status", "active")
            note = " (departed — knowledge-loss risk)" if status == "departed" else ""
            yield Record(
                id=p["id"],
                kind="person",
                title=p["name"],
                text=f"{p['name']} — {p.get('role', '')}{note}.",
                source="PLM",
                metadata={"role": p.get("role"), "status": status},
            )

    def _artifact(self, art: dict) -> Record:
        art_type = art["type"]
        structured = art.get("structured", {})
        relations: list[Relation] = []
        parent_id = None

        if art_type == "part":
            kind = "entity"
            parent_id = structured.get("parent_id")
        else:
            kind = "document"

        # Typed reference edges.
        for ref in art.get("refs", []):
            rel = _EDGE_TYPE.get((art_type, _type_of(ref)), "REFERENCES")
            relations.append(Relation(rel, ref))

        # Authorship / actor edges from structured metadata (person ids only).
        for field, rel in _PERSON_FIELDS.items():
            val = structured.get(field)
            if isinstance(val, str) and _PERSON_ID.match(val):
                relations.append(Relation(rel, val))

        return Record(
            id=art["id"],
            kind=kind,
            title=art["title"],
            text=art.get("text", ""),
            source=art["source_system"],
            parent_id=parent_id,
            refs=list(art.get("refs", [])),
            relations=relations,
            subsystem=structured.get("subsystem"),
            metadata=structured,
        )
