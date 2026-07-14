"""Adapter for a CSV/TSV export.

Each row becomes one record. A :class:`ColumnMap` names which columns carry the
id, title, text, and so on, so the adapter fits any tabular export without code
changes. ``refs`` is read from a single delimited column.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from .base import Record, SourceAdapter


@dataclass
class ColumnMap:
    id: str = "id"
    title: str = "title"
    text: str = "text"
    kind: str | None = None            # column holding "entity"/"document", or None
    parent_id: str | None = None
    subsystem: str | None = None
    refs: str | None = None            # column holding delimited ids
    refs_delimiter: str = ";"


class CsvAdapter(SourceAdapter):
    """Reads rows from a CSV (or any ``csv.Sniffer``-detectable delimiter)."""

    source = "csv"

    def __init__(
        self,
        path: str | Path,
        columns: ColumnMap | None = None,
        *,
        default_kind: str = "document",
        source: str | None = None,
    ) -> None:
        self.path = Path(path)
        self.columns = columns or ColumnMap()
        self.default_kind = default_kind
        if source:
            self.source = source

    def records(self) -> Iterator[Record]:
        with self.path.open(newline="") as fh:
            sample = fh.read(2048)
            fh.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample)
            except csv.Error:
                dialect = csv.excel
            reader = csv.DictReader(fh, dialect=dialect)
            cm = self.columns
            for row in reader:
                refs: list[str] = []
                if cm.refs and row.get(cm.refs):
                    refs = [r.strip() for r in row[cm.refs].split(cm.refs_delimiter) if r.strip()]
                known = {cm.id, cm.title, cm.text, cm.kind, cm.parent_id, cm.subsystem, cm.refs}
                metadata = {k: v for k, v in row.items() if k not in known and v}
                yield Record(
                    id=row[cm.id],
                    kind=(row.get(cm.kind) if cm.kind else None) or self.default_kind,
                    title=row.get(cm.title, row[cm.id]),
                    text=row.get(cm.text, ""),
                    source=self.source,
                    parent_id=row.get(cm.parent_id) if cm.parent_id else None,
                    subsystem=row.get(cm.subsystem) if cm.subsystem else None,
                    refs=refs,
                    metadata=metadata,
                )
