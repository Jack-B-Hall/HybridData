"""Ingestion: source adapters + the runner that turns records into a queryable store.

To add your own data source, subclass :class:`~hde.ingest.base.SourceAdapter` and
yield :class:`~hde.ingest.base.Record` objects. See ``docs/adding-a-data-source.md``.
"""
from .base import Record, Relation, SourceAdapter
from .runner import IngestResult, ingest

__all__ = ["Record", "Relation", "SourceAdapter", "ingest", "IngestResult"]
