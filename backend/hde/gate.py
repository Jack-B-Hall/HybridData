"""Deterministic evidence-sufficiency gate.

The decision to answer, hedge, or decline is made from **retrieval-side maths
only** — never by asking the language model to judge its own confidence. Small
models over-refuse when made their own judge, and any model can be talked past a
weak refusal; a gate computed from the retrieval result is stable and auditable,
and its signals are surfaced verbatim in the UI as the confidence display.

Signals (all cheap, all pre-synthesis):

    id_anchor      the question names a record id that exists in the corpus AND
                   was surfaced by retrieval — the strongest on-topic signal.
    term_coverage  fraction of the question's salient content terms present in
                   the retrieved chunk text.
    top_score      the best fused+weighted chunk score (retrieval concentration).
    n_strong       how many chunks score >= half the top score.

Verdicts:

    sufficient     answer directly (the common path).
    borderline     answer, but the synthesis prompt is told to say "not found" if
                   a specific asked-for fact is unsupported.
    insufficient   decline deterministically, with NO synthesis call, and show
                   what *was* found. This is the wall against hallucinating on
                   off-corpus questions.

The thresholds lean toward answering: the failure mode we engineer away from is
refusing real questions. The residual hard case — a real entity is retrieved but
the specific asked-for attribute simply is not recorded — is undetectable from
retrieval alone, so it is handled by the borderline synthesis instruction, not
by the gate.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

from .config import DEFAULT_DOMAIN_STOPWORDS
from .ids import ID_RE, explicit_ids
from .retrieval import RetrievedChunk

# Generic English stopwords, kept separate from the domain-flavoured list so the
# latter can be overridden for a non-engineering corpus (where e.g. "system" or
# "change" is a content word). The union below reproduces the original combined
# stoplist exactly, so default gate behaviour is unchanged.
_GENERIC_STOP = {
    "the", "and", "for", "with", "of", "in", "to", "a", "an", "is", "are", "was",
    "were", "it", "its", "be", "at", "by", "as", "or", "that", "what", "which",
    "who", "does", "do", "did", "if", "on", "how", "many", "much", "when", "why",
    "would", "will", "other", "else", "need", "needs", "needed", "any", "from",
    "this", "these", "those", "into", "get", "have", "has", "had", "there",
    "their", "them", "full",
}

#: Default combined stoplist (generic + the default domain words).
_STOP = _GENERIC_STOP | set(DEFAULT_DOMAIN_STOPWORDS)


def build_stopwords(domain_stopwords: "tuple[str, ...] | list[str]") -> set[str]:
    """Combine the generic English stoplist with a domain-specific list. Passing
    the default domain list reproduces :data:`_STOP` exactly."""
    return _GENERIC_STOP | {w.lower() for w in domain_stopwords}


@dataclass
class GateThresholds:
    """Answer/decline boundaries, calibrated on the demo corpus (see
    ``eval/calibrate_gate.py``). The decision uses term coverage and the id
    anchor; the fused ``top_score`` is retained as a displayed signal but is not
    part of the decision, because its magnitude depends on the embedder in use
    and is a poor discriminator on its own.
    """

    cov_hi: float = 0.34    # coverage at/above -> sufficient outright
    cov_mid: float = 0.20   # coverage at/above WITH a retrieved id anchor -> sufficient
    cov_void: float = 0.20  # coverage at/below, no anchor -> insufficient (a void)
    strong_frac: float = 0.5


DEFAULT_THRESHOLDS = GateThresholds()


@dataclass
class GateResult:
    verdict: str
    signals: dict = field(default_factory=dict)


def _content_terms(
    question: str, id_re: "re.Pattern[str]" = ID_RE, stopwords: set[str] = _STOP,
) -> list[str]:
    q = id_re.sub(" ", question)  # ids scored separately, via the anchor
    toks = re.findall(r"[a-zA-Z][a-zA-Z0-9\-]*", q.lower())
    out, seen = [], set()
    for t in toks:
        if len(t) < 3 or t in stopwords or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _known_ids(conn: sqlite3.Connection, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    ph = ",".join("?" * len(ids))
    rows = conn.execute(f"SELECT id FROM artifacts WHERE id IN ({ph})", ids).fetchall()
    return {r[0] for r in rows}


def compute_signals(
    conn: sqlite3.Connection, question: str, chunks: list[RetrievedChunk],
    thresholds: GateThresholds = DEFAULT_THRESHOLDS,
    id_re: "re.Pattern[str]" = ID_RE, stopwords: set[str] = _STOP,
) -> dict:
    retrieved_ids = {c.artifact_id for c in chunks}
    q_ids = explicit_ids(question, id_re)
    known = _known_ids(conn, q_ids)
    named_known = [i for i in q_ids if i in known]
    named_retrieved = [i for i in named_known if i in retrieved_ids]

    terms = _content_terms(question, id_re, stopwords)
    haystack = " ".join(f"{c.title} {c.body}" for c in chunks).lower()
    hits = [t for t in terms if t in haystack]
    coverage = (len(hits) / len(terms)) if terms else 0.0

    scores = [c.score for c in chunks]
    top = max(scores) if scores else 0.0
    n_strong = sum(1 for s in scores if top and s >= thresholds.strong_frac * top)

    return {
        "question_ids": q_ids,
        "named_known": named_known,
        "named_retrieved": named_retrieved,
        "id_anchor": bool(named_retrieved),
        "n_terms": len(terms),
        "term_coverage": round(coverage, 3),
        "top_score": round(top, 5),
        "n_strong": n_strong,
        "n_chunks": len(chunks),
    }


def decide(signals: dict, thresholds: GateThresholds = DEFAULT_THRESHOLDS) -> str:
    if signals["n_chunks"] == 0:
        return "insufficient"
    cov = signals["term_coverage"]
    anchor = signals["id_anchor"]
    # Strong on-topic vocabulary, or a named+retrieved id with some overlap.
    if cov >= thresholds.cov_hi:
        return "sufficient"
    if anchor and cov >= thresholds.cov_mid:
        return "sufficient"
    # No anchor and almost no vocabulary overlap -> the corpus is off-topic.
    if not anchor and cov <= thresholds.cov_void:
        return "insufficient"
    # Ambiguous middle band -> answer, but with the grounded "say not found" note.
    return "borderline"


def evaluate(
    conn: sqlite3.Connection, question: str, chunks: list[RetrievedChunk],
    thresholds: GateThresholds = DEFAULT_THRESHOLDS,
    id_re: "re.Pattern[str]" = ID_RE, stopwords: set[str] = _STOP,
) -> GateResult:
    signals = compute_signals(conn, question, chunks, thresholds, id_re, stopwords)
    return GateResult(verdict=decide(signals, thresholds), signals=signals)
