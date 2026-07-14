"""Record-id detection, shared by retrieval and the gate.

Record ids have a compact shape — a short upper-case prefix, a hyphen, and digits
(``P-1092``, ``ECR-214``, ``ECN-312``). Questions that name an id are asking about
a specific record, so both the retriever (force-include it) and the gate (treat it
as an on-topic anchor) need to spot them.
"""
from __future__ import annotations

import re

ID_RE = re.compile(r"\b[A-Z]{1,6}-\d+\b")


def explicit_ids(text: str) -> list[str]:
    """Ordered, de-duplicated record ids named in ``text``."""
    out: list[str] = []
    for m in ID_RE.findall(text):
        if m not in out:
            out.append(m)
    return out
