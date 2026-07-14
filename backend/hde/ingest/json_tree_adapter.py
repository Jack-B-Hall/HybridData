"""Adapter for a single nested JSON hierarchy (an assembly / org / taxonomy tree).

Given a JSON document whose nodes nest via a ``children`` array, this yields one
**entity** record per node with ``parent_id`` set from the nesting, reproducing
the structural backbone (finding #2) from an explicit tree rather than from flat
records with parent pointers. Field names are configurable so you can point it at
your own tree shape.

Example input (``data/parts-tree.json``)::

    {"id": "P-1000", "title": "Kestrel K-200", "children": [
        {"id": "P-1001", "title": "Fuselage", "subsystem": "Airframe",
         "text": "...", "children": [ ... ]}
    ]}
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from .base import Record, SourceAdapter


class JsonTreeAdapter(SourceAdapter):
    """Reads a nested JSON tree into a flat stream of parented entity records."""

    source = "PLM"

    def __init__(
        self,
        path: str | Path,
        *,
        id_field: str = "id",
        title_field: str = "title",
        text_field: str = "text",
        children_field: str = "children",
        source: str | None = None,
    ) -> None:
        self.path = Path(path)
        self.id_field = id_field
        self.title_field = title_field
        self.text_field = text_field
        self.children_field = children_field
        if source:
            self.source = source

    def records(self) -> Iterator[Record]:
        root = json.loads(self.path.read_text())
        roots = root if isinstance(root, list) else [root]
        for node in roots:
            yield from self._walk(node, parent_id=None)

    def _walk(self, node: dict, parent_id: str | None) -> Iterator[Record]:
        node_id = node[self.id_field]
        children = node.get(self.children_field, []) or []
        meta = {
            k: v
            for k, v in node.items()
            if k not in (self.id_field, self.title_field, self.text_field, self.children_field)
        }
        yield Record(
            id=node_id,
            kind="entity",
            title=node.get(self.title_field, node_id),
            text=node.get(self.text_field, ""),
            source=self.source,
            parent_id=parent_id,
            subsystem=node.get("subsystem"),
            metadata=meta,
        )
        for child in children:
            yield from self._walk(child, parent_id=node_id)
