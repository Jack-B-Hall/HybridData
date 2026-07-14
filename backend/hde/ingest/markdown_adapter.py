"""Adapter for a directory of Markdown documents.

Each ``.md`` file becomes one **document** record. An optional YAML-ish front
matter block (``--- ... ---`` at the top of the file) supplies metadata; keys
``id``, ``title``, ``source``, ``subsystem`` and ``refs`` (comma-separated) are
recognised, everything else is preserved in ``metadata``. Without front matter,
the id is the filename stem and the title is the first heading.

This is the smallest realistic adapter, and a good template to copy.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator

from .base import Record, SourceAdapter


def _parse_front_matter(raw: str) -> tuple[dict, str]:
    """Split optional ``--- ... ---`` front matter from the body. No YAML dep:
    supports simple ``key: value`` lines, which covers document metadata."""
    if not raw.startswith("---"):
        return {}, raw
    end = raw.find("\n---", 3)
    if end == -1:
        return {}, raw
    header = raw[3:end].strip()
    body = raw[end + 4 :].lstrip("\n")
    meta: dict = {}
    for line in header.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta, body


def _first_heading(body: str, fallback: str) -> str:
    for line in body.splitlines():
        if line.startswith("#"):
            return line.lstrip("#").strip()
    return fallback


class MarkdownDirectoryAdapter(SourceAdapter):
    """Reads ``*.md`` files (recursively) from a directory."""

    source = "markdown"

    def __init__(self, root: str | Path, source: str | None = None) -> None:
        self.root = Path(root)
        if source:
            self.source = source

    def records(self) -> Iterator[Record]:
        for path in sorted(self.root.rglob("*.md")):
            meta, body = _parse_front_matter(path.read_text())
            rec_id = meta.pop("id", None) or path.stem
            title = meta.pop("title", None) or _first_heading(body, path.stem)
            refs = [r.strip() for r in meta.pop("refs", "").split(",") if r.strip()]
            yield Record(
                id=rec_id,
                kind="document",
                title=title,
                text=body,
                source=meta.pop("source", "") or self.source,
                subsystem=meta.pop("subsystem", None),
                refs=refs,
                metadata=meta,
            )
