"""Chunking: split a record's text into retrieval units.

Each chunk records the character span ``[char_start, char_end)`` it occupies in
the source text, so a citation can be resolved back to the exact passage in the
document viewer, not just to the document. Every chunk body is prefixed with the
record id and title so lexical search can always find a record by its id.
"""
from __future__ import annotations

from dataclasses import dataclass

CHUNK_MAX_CHARS = 1800  # ~450 tokens at 4 chars/token


@dataclass
class Chunk:
    chunk_idx: int
    char_start: int
    char_end: int
    body: str


def chunk_text(text: str, record_id: str, title: str, max_chars: int = CHUNK_MAX_CHARS) -> list[Chunk]:
    """Split ``text`` into chunks on paragraph boundaries.

    Spans point into the *original* ``text`` (excluding the injected header), so
    the document viewer can highlight the cited passage precisely.
    """
    header = f"{record_id} | {title}"
    body = text.strip()
    if not body:
        body = title

    if len(body) <= max_chars:
        return [Chunk(0, 0, len(body), f"{header}\n\n{body}")]

    chunks: list[Chunk] = []
    idx = 0
    cursor = 0          # offset in `body` where the current chunk starts
    current = ""
    # Walk paragraphs, tracking offsets in the original body.
    parts = body.split("\n\n")
    offset = 0
    para_spans: list[tuple[int, str]] = []
    for para in parts:
        para_spans.append((offset, para))
        offset += len(para) + 2  # +2 for the "\n\n" separator we split on

    for start_off, para in para_spans:
        candidate = (current + "\n\n" + para) if current else para
        if len(candidate) > max_chars and current:
            end = start_off  # current chunk ends where this paragraph starts
            chunks.append(Chunk(idx, cursor, end, f"{header}\n\n{current.strip()}"))
            idx += 1
            cursor = start_off
            current = para
        else:
            current = candidate
    if current.strip():
        chunks.append(Chunk(idx, cursor, len(body), f"{header}\n\n{current.strip()}"))
    return chunks
