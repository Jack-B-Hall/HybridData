"""Pluggable answer models.

Synthesis needs exactly one thing from a model: given a grounded request, produce
answer text that ends with a small JSON block declaring the claims, the citation
ids used, and any graph paths referenced. That shared output shape means one
parser in :mod:`hde.synthesis` handles every backend.

Backends (select via ``HDE_LLM_BACKEND``):

* ``mock`` — deterministic and offline. It does **not** interpret the prose
  prompt; it grounds directly on the structured retrieval result, emitting one
  cited sentence per top source. Answers are terse rather than fluent, but every
  citation is real, so the demo, the e2e tests, and CI run with no GPU and no
  network. This is the default.
* ``ollama`` — a local model (e.g. a gemma-class 12-27B) over the Ollama HTTP API.
* ``anthropic`` — the Claude API via the official ``anthropic`` SDK.

Real backends receive the fully-rendered prompt; the mock receives the structured
context. Both return a string in the same format.
"""
from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass, field
from typing import Iterator, Protocol

from .config import Settings


@dataclass
class SynthesisRequest:
    """Everything a backend needs to answer one question."""

    question: str
    system_prompt: str
    user_prompt: str
    # Structured context, used by the mock to ground deterministically.
    chunks: list[dict] = field(default_factory=list)
    graph_paths: list[str] = field(default_factory=list)
    borderline: bool = False


class LLMClient(Protocol):
    name: str

    def synthesize(self, request: SynthesisRequest) -> str:
        """Return raw answer text ending in the JSON claims block."""
        ...

    def synthesize_stream(self, request: SynthesisRequest) -> Iterator[str]:
        """Yield raw answer text incrementally (same format as ``synthesize``).

        The concatenation of all yielded chunks equals what ``synthesize`` would
        return. Backends that cannot stream may yield a single chunk. The blocking
        ``synthesize`` remains the canonical path used by the CLI and tests.
        """
        ...


def _render_json_block(claims: list[dict], citations: list[str], paths: list[str]) -> str:
    payload = {"claims": claims, "citations": citations, "graph_paths": paths}
    return "```json\n" + json.dumps(payload) + "\n```"


class MockLLM:
    """Deterministic, grounded, offline answer model.

    Produces a short answer that cites the top retrieved sources by their ordinal
    ([1], [2], ...). Because it reads the real retrieval result, the citations in
    the UI open the real passages that were retrieved.
    """

    name = "mock/mock"

    def synthesize(self, request: SynthesisRequest) -> str:
        chunks = request.chunks[:3]
        if not chunks:
            return (
                "Not found in the provided corpus context.\n\n"
                + _render_json_block([], [], [])
            )

        sentences: list[str] = []
        claims: list[dict] = []
        citations: list[str] = []
        for i, c in enumerate(chunks, start=1):
            aid = c["artifact_id"]
            citations.append(aid)
            snippet = _first_sentence(c.get("body", ""), c.get("title", ""))
            sentence = f"{snippet} [{i}]"
            sentences.append(sentence)
            claims.append({"text": sentence, "citations": [aid]})

        answer = " ".join(sentences)
        if request.graph_paths:
            answer += (
                "\n\nRelated records are linked in the knowledge graph "
                f"({len(request.graph_paths)} relationship paths surfaced)."
            )
        if request.borderline:
            answer += (
                "\n\n(Confidence is borderline: the corpus is only partially on-topic "
                "for this question; treat the answer as indicative.)"
            )
        return answer + "\n\n" + _render_json_block(
            claims, citations, request.graph_paths[:12]
        )

    def synthesize_stream(self, request: SynthesisRequest) -> Iterator[str]:
        """Emit the deterministic answer as a few word-group chunks so the demo
        and offline tests exercise the same streaming path as a live model."""
        full = self.synthesize(request)
        # Chunk on whitespace boundaries into small groups; the JSON metadata
        # block rides along as later chunks (the engine strips it from the
        # displayed prose exactly as it does for a live model's trailing block).
        words = full.split(" ")
        group = 4
        for i in range(0, len(words), group):
            piece = " ".join(words[i : i + group])
            yield piece if i == 0 else " " + piece


def _first_sentence(body: str, title: str) -> str:
    """Extract a readable grounding sentence from a chunk body."""
    # Strip the "ID | Title" header line the ingester prepends.
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    text = ""
    for ln in lines:
        if "|" in ln and len(ln) < 120 and ln.split("|")[0].strip().count(" ") == 0:
            continue  # header line
        text = ln
        break
    text = text or (lines[0] if lines else title)
    # A markdown-source chunk often opens with its "# Title" heading line; the
    # mock splices that mid-sentence, where a literal heading marker is noise
    # in the rendered answer, so drop the marker (keeping the words).
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text)
    # First sentence, capped.
    for stop in (". ", "! ", "? ", "\n"):
        idx = text.find(stop)
        if 0 < idx < 240:
            return text[: idx + 1].strip()
    return text[:240].strip()


class OllamaLLM:
    """A local model served by Ollama's ``/api/chat`` endpoint."""

    def __init__(self, host: str, model: str, timeout_s: int, num_ctx: int,
                 think: bool = False, num_predict: int = 1500) -> None:
        self.host = host.rstrip("/")
        self.model = model
        self.timeout_s = timeout_s
        self.num_ctx = num_ctx
        self.think = think
        self.num_predict = num_predict
        self.name = f"ollama/{model}"

    def synthesize(self, request: SynthesisRequest) -> str:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": self.num_predict, "num_ctx": self.num_ctx},
            # Disable chain-of-thought for reasoning-tuned models by default: it
            # multiplies latency for no citation-grounding benefit here. Ignored
            # by models without a thinking mode.
            "think": self.think,
        }
        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.host}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            data = json.loads(resp.read())
        return data["message"]["content"]

    def synthesize_stream(self, request: SynthesisRequest) -> Iterator[str]:
        """Stream answer deltas from Ollama's line-delimited ``/api/chat`` feed.

        With ``stream: true`` Ollama returns one JSON object per line, each
        carrying a ``message.content`` delta, terminated by a line with
        ``done: true``. We forward the content deltas as they arrive; the
        ``thinking`` field (present only when ``think`` is enabled) is not part
        of the answer and is deliberately skipped.
        """
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_prompt},
            ],
            "stream": True,
            "options": {"temperature": 0.1, "num_predict": self.num_predict, "num_ctx": self.num_ctx},
            "think": self.think,
        }
        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.host}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            for line in resp:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                piece = obj.get("message", {}).get("content", "")
                if piece:
                    yield piece
                if obj.get("done"):
                    break


class AnthropicLLM:
    """The Claude API via the official ``anthropic`` SDK (lazy-imported)."""

    def __init__(self, model: str, timeout_s: int) -> None:
        import anthropic  # local import: optional dep

        self._client = anthropic.Anthropic(timeout=timeout_s)
        self.model = model
        self.name = f"anthropic/{model}"

    def synthesize(self, request: SynthesisRequest) -> str:
        msg = self._client.messages.create(
            model=self.model,
            max_tokens=2000,
            system=request.system_prompt,
            messages=[{"role": "user", "content": request.user_prompt}],
        )
        return "".join(block.text for block in msg.content if block.type == "text")

    def synthesize_stream(self, request: SynthesisRequest) -> Iterator[str]:
        """Stream text deltas from the Claude API via the SDK's streaming helper."""
        with self._client.messages.stream(
            model=self.model,
            max_tokens=2000,
            system=request.system_prompt,
            messages=[{"role": "user", "content": request.user_prompt}],
        ) as stream:
            for text in stream.text_stream:
                if text:
                    yield text


def build_llm(settings: Settings) -> LLMClient:
    """Construct the answer model named by ``settings.llm_backend``."""
    backend = settings.llm_backend.lower()
    if backend == "mock":
        return MockLLM()
    if backend == "ollama":
        return OllamaLLM(
            host=settings.ollama_llm_host,
            model=settings.llm_model,
            timeout_s=settings.llm_timeout_s,
            num_ctx=settings.llm_num_ctx,
            think=settings.llm_think,
            num_predict=settings.llm_num_predict,
        )
    if backend == "anthropic":
        return AnthropicLLM(model=settings.llm_model, timeout_s=settings.llm_timeout_s)
    raise ValueError(
        f"unknown llm backend {settings.llm_backend!r} (use mock|ollama|anthropic)"
    )
