"""Record-id detection, shared by retrieval and the gate.

Record ids have a compact shape — by default a short upper-case prefix, a hyphen,
and digits (``P-1092``, ``ECR-214``, ``ECN-312``). Questions that name an id are
asking about a specific record, so both the retriever (force-include it) and the
gate (treat it as an on-topic anchor) need to spot them.

The shape is **configurable**: real sources use different id conventions (numeric
Teamcenter ids, no-hyphen part numbers, dotted CR numbers, …). Set ``HDE_ID_PATTERN``
(or an adapter-declared pattern) and it is persisted in the store's ``meta`` at
ingest so query-time matching always equals ingest-time. The default below keeps
the demo's behaviour unchanged.
"""
from __future__ import annotations

import re

#: Default record-id shape (a short prefix, a hyphen, digits). Kept as the value
#: of ``Settings.id_pattern`` so demo behaviour is identical out of the box.
ID_PATTERN_DEFAULT = r"\b[A-Z]{1,6}-\d+\b"

#: Compiled default, used wherever an explicit pattern isn't threaded through.
ID_RE = re.compile(ID_PATTERN_DEFAULT)


def build_id_re(pattern: str | None) -> "re.Pattern[str]":
    """Compile ``pattern`` into a record-id matcher, falling back to the default
    on an empty or invalid pattern (so a bad env value can never crash serving)."""
    if not pattern:
        return ID_RE
    try:
        return re.compile(pattern)
    except re.error:
        return ID_RE


def explicit_ids(text: str, id_re: "re.Pattern[str]" = ID_RE) -> list[str]:
    """Ordered, de-duplicated record ids named in ``text``."""
    out: list[str] = []
    for m in id_re.findall(text):
        if m not in out:
            out.append(m)
    return out
