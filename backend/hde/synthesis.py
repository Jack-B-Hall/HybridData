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
from dataclasses import dataclass, field

from .llm import LLMClient, SynthesisRequest
from .retrieval import RetrievedChunk

SYSTEM_PROMPT = """\
You are a precise engineering-knowledge assistant. You answer strictly from the
provided context: retrieved document chunks (each tagged with a provenance tier),
knowledge-graph relationships, and precomputed impact/dependency closures.

Rules:
1. Use ONLY the provided context. Never invent ids, dates, names, or facts.
2. Cite the record ids you rely on inline as [1], [2], ... in first-use order.
3. For provenance or decision questions, lay out the chain of events step by step.
4. For impact or dependency questions, prefer the closures and graph relationships.
5. Prefer formal-tier sources; if a claim rests on an unverified source, say so.
6. Be concise and factual. Lead with the answer.

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
            parts.append(f"### [{c.artifact_id}] {c.title}  <provenance: {c.tier_label}>\n{c.body}\n")
    if closures:
        parts.append("\n## Impact / dependency closures\n")
        for cl in closures:
            parts.append(cl["summary"] + "\n")
    if graph_paths:
        parts.append("\n## Knowledge-graph relationships\n")
        parts += [f"- {p}" for p in graph_paths[:40]]
    return "\n".join(parts)


def _parse_json_block(raw: str) -> dict:
    """Extract the trailing ```json ...``` block (or a bare trailing object).

    The block is the *outermost* object after the fence, so we scan forward from
    the first ``{`` and balance braces — scanning backwards would wrongly latch
    onto a nested claim object.
    """
    text = raw
    if "```" in raw:
        fence = raw.rfind("```json")
        if fence == -1:
            fence = raw.rfind("```")
        segment = raw[fence:].lstrip("`")
        if segment.startswith("json"):
            segment = segment[4:]
        end = segment.find("```")
        text = segment[:end] if end != -1 else segment
    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return {}
    return {}


def _strip_json_block(raw: str) -> str:
    if "```" in raw:
        fence = raw.rfind("```json")
        if fence == -1:
            fence = raw.rfind("```")
        if fence > 0:
            return raw[:fence].rstrip()
    return raw.strip()


def synthesize(
    llm: LLMClient,
    question: str,
    chunks: list[RetrievedChunk],
    graph_paths: list[str],
    closures: list[dict],
    *,
    borderline: bool = False,
) -> Answer:
    context = build_context(chunks, graph_paths, closures)
    user_prompt = f"Question: {question}\n\nContext:\n{context}"
    if borderline:
        user_prompt += BORDERLINE_NOTE

    raw = llm.synthesize(
        SynthesisRequest(
            question=question,
            system_prompt=SYSTEM_PROMPT,
            user_prompt=user_prompt,
            chunks=[c.as_dict() for c in chunks],
            graph_paths=graph_paths,
            borderline=borderline,
        )
    )

    meta = _parse_json_block(raw)
    prose = _strip_json_block(raw)

    cited_ids: list[str] = [str(c) for c in meta.get("citations", []) if c]
    claims = [
        Claim(text=str(c.get("text", "")), citations=[str(x) for x in c.get("citations", [])])
        for c in meta.get("claims", [])
        if isinstance(c, dict)
    ]
    paths = [str(p) for p in meta.get("graph_paths", [])] or graph_paths

    # Fall back to the retrieval entry ids if the model declared none.
    if not cited_ids:
        cited_ids = [c.artifact_id for c in chunks[:5]]

    by_artifact = {c.artifact_id: c for c in chunks}
    citations: list[Citation] = []
    for i, aid in enumerate(_dedupe(cited_ids), start=1):
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

    return Answer(text=prose, claims=claims, citations=citations, graph_paths=paths)


def _dedupe(ids: list[str]) -> list[str]:
    out, seen = [], set()
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out
