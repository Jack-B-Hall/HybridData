"""Answer synthesis: assemble grounded context, generate, and resolve citations.

The synthesis prompt asks the model for an answer plus a small trailing JSON block
declaring its claims, the record ids it used, and any graph paths it relied on.
We parse that block and resolve every cited id back to the retrieved chunk that
grounds it — including the character span — so the UI can open the exact passage.
Citations are therefore first-class: they are not scraped from the prose, they are
declared by the model and verified against what was actually retrieved.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .ids import ID_RE
from .llm import LLMClient, SynthesisRequest
from .retrieval import RetrievedChunk

SYSTEM_PROMPT = """\
You are a precise engineering-knowledge assistant. You answer strictly from the
provided context: retrieved document chunks (each tagged with a provenance tier),
knowledge-graph relationships, and precomputed impact/dependency closures.

Rules:
1. Use ONLY the provided context. Never invent ids, dates, names, or facts.
2. Cite inline using the bracketed record id, e.g. [ECR-214] or [ECN-312]. Put
   each id in its own brackets. In the JSON block use BARE ids only (e.g.
   "ECR-214"), never the bracketed header form.
3. For provenance or decision questions, lay out the chain of events step by step.
4. For impact or dependency questions, prefer the closures and graph relationships.
5. Prefer formal-tier sources; if a claim rests on an unverified source, say so.
6. Be concise and factual. Lead with the answer. Write in plain prose sentences —
   do NOT use markdown headings, bold, bullet lists, tables, or LaTeX.

End your response with a JSON block, on its own lines, fenced as ```json:
{"claims": [{"text": "<one claim>", "citations": ["ID", ...]}, ...],
 "citations": ["ID1", "ID2", ...],
 "graph_paths": ["A -REL-> B", ...]}
Include only ids and paths you actually used, in first-use order."""

BORDERLINE_NOTE = (
    "\n\nIMPORTANT: the retrieved context may not fully cover this question. If a "
    "specific asked-for fact is not present in the context above, say it is not "
    "found rather than guessing."
)


@dataclass
class Citation:
    marker: int
    artifact_id: str
    title: str = ""
    source: str = ""
    tier_label: str = ""
    chunk_idx: int = 0
    char_start: int = 0
    char_end: int = 0
    passage: str = ""
    grounded: bool = False  # True if resolved to a retrieved chunk

    def as_dict(self) -> dict:
        return {
            "marker": self.marker,
            "artifact_id": self.artifact_id,
            "title": self.title,
            "source": self.source,
            "tier_label": self.tier_label,
            "chunk_idx": self.chunk_idx,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "passage": self.passage,
            "grounded": self.grounded,
        }


@dataclass
class Claim:
    text: str
    citations: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"text": self.text, "citations": self.citations}


@dataclass
class Answer:
    text: str
    claims: list[Claim] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    graph_paths: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "claims": [c.as_dict() for c in self.claims],
            "citations": [c.as_dict() for c in self.citations],
            "graph_paths": self.graph_paths,
        }


def build_context(chunks: list[RetrievedChunk], graph_paths: list[str], closures: list[dict]) -> str:
    parts: list[str] = []
    if chunks:
        parts.append("## Retrieved document chunks (with provenance tier)\n")
        for c in chunks:
            parts.append(
                f"### {c.artifact_id} — {c.title}  (provenance: {c.tier_label})\n{c.body}\n"
            )
    if closures:
        parts.append("\n## Impact / dependency closures\n")
        for cl in closures:
            parts.append(cl["summary"] + "\n")
    if graph_paths:
        parts.append("\n## Knowledge-graph relationships\n")
        parts += [f"- {p}" for p in graph_paths[:40]]
    return "\n".join(parts)


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)

# Markers that introduce the trailing metadata block. Small models are
# inconsistent about fencing it, so we split on the earliest of any of these.
_META_MARKERS = ("```json", "```", '{"claims"', '"claims"', "claims\"", '{"citations"', '"citations"')

# citations/claims arrays, tolerant of missing fences/braces from small models.
_CITATIONS_ARR = re.compile(r'"?citations"?\s*:\s*\[(.*?)\]', re.DOTALL)
_PATHS_ARR = re.compile(r'"?graph_paths"?\s*:\s*\[(.*?)\]', re.DOTALL)


def _strip_reasoning(raw: str) -> str:
    """Drop reasoning-model scratchpad blocks (``<think>...</think>``) so they
    never leak into the displayed answer."""
    return _THINK_RE.sub("", raw)


def _clean_markup(text: str) -> str:
    """Normalise a model's markdown/LaTeX into clean plain text.

    The answer view renders plain prose, but real models emit markdown headings,
    bold, code spans and the odd LaTeX arrow regardless of instructions. Strip the
    markup (keeping the words) so nothing renders as literal ``**`` or ``$\\to$``.
    Record ids like ``P-1062`` are untouched — only paired/leading markers go.
    """
    for a, b in (("$\\rightarrow$", "→"), ("\\rightarrow", "→"),
                 ("$\\to$", "→"), ("\\to", "→"), ("$\\times$", "×")):
        text = text.replace(a, b)
    text = re.sub(r"`([^`]*)`", r"\1", text)              # inline code spans
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)        # **bold**
    text = re.sub(r"__([^_]+)__", r"\1", text)            # __bold__
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)     # # headings
    text = re.sub(r"(?m)^(\s*)[*\-]\s+", r"\1• ", text)   # bullets -> •
    text = re.sub(r"\$([^$\n]*)\$", r"\1", text)          # stray inline math
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _normalize_id(token: str) -> str:
    """Extract a bare record id from whatever a model emitted for a citation.

    Models often echo the context header form ``[ECN-312] Approved Change ...``
    or ``ECN-312 — Approved Change``; we want just ``ECN-312``."""
    m = ID_RE.search(token)
    return m.group(0) if m else token.strip().strip("[]").strip()


def _split_meta(raw: str) -> tuple[str, str]:
    """Split the model output into (displayed prose, trailing metadata text).

    Robust to an unfenced or malformed metadata block: we cut at the earliest
    metadata marker so the JSON never leaks into the answer shown to the user.
    """
    cut = len(raw)
    for marker in _META_MARKERS:
        i = raw.find(marker)
        if i != -1:
            cut = min(cut, i)
    return raw[:cut].rstrip().rstrip("`").rstrip(), raw[cut:]


def _ids_from_array(body: str) -> list[str]:
    ids: list[str] = []
    for token in re.findall(r'"([^"]+)"', body):
        norm = _normalize_id(token)
        if norm and norm not in ids:
            ids.append(norm)
    return ids


def _parse_meta(tail: str) -> dict:
    """Best-effort structured metadata from the (possibly malformed) tail.

    Tries strict JSON first; falls back to regex extraction of the citations and
    graph_paths arrays, which survives missing fences and unbalanced braces."""
    text = tail.strip().strip("`")
    if text.startswith("json"):
        text = text[4:]
    # Strict parse if it happens to be well-formed.
    start = text.find("{")
    if start != -1:
        try:
            return json.loads(text[start : text.rfind("}") + 1])
        except (json.JSONDecodeError, ValueError):
            pass
    # Lenient fallback.
    meta: dict = {}
    cm = _CITATIONS_ARR.search(text)
    if cm:
        meta["citations"] = _ids_from_array(cm.group(1))
    pm = _PATHS_ARR.search(text)
    if pm:
        meta["graph_paths"] = [p.strip() for p in re.findall(r'"([^"]+)"', pm.group(1))]
    return meta


def build_request(
    question: str,
    chunks: list[RetrievedChunk],
    graph_paths: list[str],
    closures: list[dict],
    *,
    borderline: bool = False,
) -> SynthesisRequest:
    """Assemble the grounded prompt a backend needs to answer one question."""
    context = build_context(chunks, graph_paths, closures)
    user_prompt = f"Question: {question}\n\nContext:\n{context}"
    if borderline:
        user_prompt += BORDERLINE_NOTE
    return SynthesisRequest(
        question=question,
        system_prompt=SYSTEM_PROMPT,
        user_prompt=user_prompt,
        chunks=[c.as_dict() for c in chunks],
        graph_paths=graph_paths,
        borderline=borderline,
    )


def displayed_prose_so_far(raw_accumulated: str) -> str:
    """The prose portion of a partial stream, with the trailing metadata block
    (once it begins) excluded. Used to drive incremental rendering: as raw text
    arrives, this returns what should be shown, never leaking the JSON block."""
    return _split_meta(_strip_reasoning(raw_accumulated))[0]


def synthesize(
    llm: LLMClient,
    question: str,
    chunks: list[RetrievedChunk],
    graph_paths: list[str],
    closures: list[dict],
    *,
    borderline: bool = False,
) -> Answer:
    raw = llm.synthesize(build_request(question, chunks, graph_paths, closures, borderline=borderline))
    return parse_synthesis(raw, chunks, graph_paths)


def stream_synthesis(
    llm: LLMClient,
    question: str,
    chunks: list[RetrievedChunk],
    graph_paths: list[str],
    closures: list[dict],
    *,
    borderline: bool = False,
):
    """Generator that yields each newly-displayable slice of answer prose as the
    model streams, and *returns* the fully-parsed :class:`Answer` (accessible via
    ``StopIteration.value`` or ``yield from``).

    The same parser as :func:`synthesize` runs over the accumulated raw text, so
    the returned Answer's citations, claims, and cleaned prose are identical to
    the blocking path — streaming only changes *when* the prose becomes visible.
    """
    request = build_request(question, chunks, graph_paths, closures, borderline=borderline)
    raw_parts: list[str] = []
    emitted = 0
    for piece in llm.synthesize_stream(request):
        raw_parts.append(piece)
        prose_now = displayed_prose_so_far("".join(raw_parts))
        if len(prose_now) > emitted:
            yield prose_now[emitted:]
            emitted = len(prose_now)
    return parse_synthesis("".join(raw_parts), chunks, graph_paths)


def parse_synthesis(
    raw: str, chunks: list[RetrievedChunk], graph_paths: list[str]
) -> Answer:
    """Turn a backend's raw output into a grounded :class:`Answer`.

    Shared by the blocking and streaming synthesis paths so both resolve
    citations against the retrieved chunks identically."""
    raw = _strip_reasoning(raw)
    prose, tail = _split_meta(raw)
    prose = _clean_markup(prose)
    meta = _parse_meta(tail)

    cited_ids: list[str] = [_normalize_id(str(c)) for c in meta.get("citations", []) if c]
    claims = [
        Claim(
            text=str(c.get("text", "")),
            citations=[_normalize_id(str(x)) for x in c.get("citations", [])],
        )
        for c in meta.get("claims", [])
        if isinstance(c, dict)
    ]
    paths = [str(p) for p in meta.get("graph_paths", [])] or graph_paths

    # Fall back to the retrieval entry ids if the model declared none.
    if not cited_ids:
        cited_ids = [c.artifact_id for c in chunks[:5]]

    by_artifact = {c.artifact_id: c for c in chunks}

    # Promote any ids referenced inline in the prose (models often write
    # "[ECR-214]" instead of a numeric marker) into the ordered citation list.
    ordered_ids = _dedupe(cited_ids)
    for group in _INLINE_REF.findall(prose):
        for norm in ID_RE.findall(group):
            if norm in by_artifact and norm not in ordered_ids:
                ordered_ids.append(norm)

    citations: list[Citation] = []
    marker_of: dict[str, int] = {}
    for i, aid in enumerate(ordered_ids, start=1):
        marker_of[aid] = i
        chunk = by_artifact.get(aid)
        if chunk:
            citations.append(
                Citation(
                    marker=i, artifact_id=aid, title=chunk.title, source=chunk.source,
                    tier_label=chunk.tier_label, chunk_idx=chunk.chunk_idx,
                    char_start=chunk.char_start, char_end=chunk.char_end,
                    passage=chunk.body, grounded=True,
                )
            )
        else:
            citations.append(Citation(marker=i, artifact_id=aid, grounded=False))

    # Rewrite inline bracketed id references (e.g. "[ECN-312, ECR-214]") into the
    # numeric markers the UI renders as citation chips ("[1][2]").
    prose = _rewrite_inline_citations(prose, marker_of, n_citations=len(citations))

    return Answer(text=prose, claims=claims, citations=citations, graph_paths=paths)


# A bracketed group that contains at least one record id (not a pure-numeric [1]).
_INLINE_REF = re.compile(r"\[([^\[\]]*?[A-Z]{1,6}-\d+[^\[\]]*?)\]")
# A bracketed group of one or more comma/space-separated numbers, e.g. [1, 4].
_NUMERIC_GROUP = re.compile(r"\[(\d+(?:\s*[,;]\s*\d+)*)\]")


def _rewrite_inline_citations(prose: str, marker_of: dict[str, int], n_citations: int = 0) -> str:
    """Normalise whatever inline citation form a model produced into single
    ``[n]`` markers the UI renders as chips.

    Handles ``[ECR-214]`` and ``[ECN-312, ECR-214]`` (mapped by id) and stray
    numeric groups like ``[1, 4]`` (split into ``[1][4]``, dropping any number
    outside the citation range)."""
    def repl_ids(match: re.Match) -> str:
        ids = ID_RE.findall(match.group(1))
        markers = [f"[{marker_of[i]}]" for i in ids if i in marker_of]
        return "".join(markers) if markers else match.group(0)

    prose = _INLINE_REF.sub(repl_ids, prose)

    limit = n_citations or (max(marker_of.values()) if marker_of else 0)

    def repl_nums(match: re.Match) -> str:
        nums = [int(n) for n in re.split(r"[,;]\s*", match.group(1))]
        keep = [f"[{n}]" for n in nums if 1 <= n <= limit]
        return "".join(keep) if keep else ""

    return _NUMERIC_GROUP.sub(repl_nums, prose)


def _dedupe(ids: list[str]) -> list[str]:
    out, seen = [], set()
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out
