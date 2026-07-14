"""The source-adapter contract.

An adapter's only job is to read *some* source of truth and yield a stream of
normalised :class:`Record` objects. Everything downstream — chunking, embedding,
graph construction, provenance tagging, impact-closure precompute — is handled by
the runner, identically for every source. That is the whole extensibility story:
teach the system a new source by writing one small adapter.

A minimal adapter is a few lines::

    from hde.ingest import Record, SourceAdapter

    class TicketsAdapter(SourceAdapter):
        source = "Jira"                       # provenance label -> tier

        def records(self):
            for row in self._read():          # your source
                yield Record(
                    id=row["key"],
                    kind="document",
                    title=row["summary"],
                    text=row["description"],
                    refs=row["links"],        # ids of related records
                )

See ``docs/adding-a-data-source.md`` for a complete worked example.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Iterator

VALID_KINDS = ("entity", "document", "person")


@dataclass
class Relation:
    """A typed, directed knowledge-graph edge from a record to a target id.

    Use this for edges whose *meaning* matters in the graph view (``MODIFIES``,
    ``AUTHORED_BY``, ``TRIGGERS``, ...). Plain :attr:`Record.refs` are enough when
    you only need reference edges for impact/dependency closures.
    """

    rel: str
    target_id: str


@dataclass
class Record:
    """One normalised unit of source data.

    Attributes:
        id:        Stable unique identifier (also the graph node id).
        kind:      "entity" for a node in the structural hierarchy (a part, an
                   assembly, an org unit — anything documents hang off),
                   "document" for a leaf artifact (a spec, ticket, note, drawing),
                   or "person" for an actor referenced by documents.
        title:     Short human-readable label.
        text:      Full searchable text/prose. May be empty for pure entities.
        source:    Provenance label; maps to a tier in :mod:`hde.provenance`
                   (e.g. "PLM", "Confluence", "Jira"). Defaults per-adapter.
        parent_id: For entities, the id of the parent in the hierarchy (builds
                   the assembly/PART_OF backbone). ``None`` for roots/documents.
        refs:      Ids of other records this one references. Drives the impact and
                   dependency closures, and untyped REFERENCES graph edges.
        relations: Optional typed graph edges (see :class:`Relation`).
        subsystem: Optional grouping label used by the graph explorer filters.
        metadata:  Arbitrary extra fields, preserved verbatim for the UI.
    """

    id: str
    kind: str
    title: str
    text: str = ""
    source: str = ""
    parent_id: str | None = None
    refs: list[str] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)
    subsystem: str | None = None
    metadata: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in VALID_KINDS:
            raise ValueError(f"Record.kind must be one of {VALID_KINDS}, got {self.kind!r}")
        if not self.id:
            raise ValueError("Record.id must be non-empty")


class SourceAdapter(ABC):
    """Base class for all ingestion sources.

    Subclasses set a default :attr:`source` label and implement :meth:`records`.
    """

    #: Default provenance label applied to records that don't set their own.
    source: str = "unknown"

    @abstractmethod
    def records(self) -> Iterator[Record]:
        """Yield normalised :class:`Record` objects from the source."""
        raise NotImplementedError

    def __iter__(self) -> Iterator[Record]:
        for rec in self.records():
            if not rec.source:
                rec.source = self.source
            yield rec
