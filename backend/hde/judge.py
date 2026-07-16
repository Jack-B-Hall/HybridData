"""LLM-as-judge for answer-quality evaluation on the Testing page.

The judge scores a produced answer AGAINST its golden (reference) answer and the
retrieved evidence, on an explicit rubric, and returns per-dimension scores plus a
short justification as structured JSON. It is reference-grounded, not naive
self-praise: the model is asked to compare to a reference and to the evidence, and
to penalise unsupported claims.

Rubric dimensions (each 0.0-1.0):
  * correctness    — does the answer agree with the golden answer on the key facts?
  * groundedness   — is every claim supported by the retrieved evidence (no invention)?
  * completeness   — does it cover the key points the golden answer makes?
  * citation_quality — are the cited records the right, supporting ones?

Backends mirror the answer model (mock | ollama | anthropic). The mock judge is
deterministic and offline (token-overlap heuristics) so tests, CI and the demo need
no GPU/network. IMPORTANT: judging an answer with the SAME model that produced it
inflates scores — the judge model is separately configurable (see [eval] in
hde.toml); this same-model bias is surfaced in the UI and docs.
"""
from __future__ import annotations

import json
import re

from .config import Settings
from .llm import AnthropicLLM, MockLLM, OllamaLLM, SynthesisRequest

RUBRIC_DIMS = ("correctness", "groundedness", "completeness", "citation_quality")

# Errors whose message signals the backend is unreachable rather than a bad answer.
_CONN_HINTS = (
    "route to host", "connection refused", "connection reset", "timed out",
    "timeout", "failed to establish", "name or service not known",
    "urlopen error", "max retries", "no route",
)

JUDGE_SYSTEM = (
    "You are a strict evaluation judge for a document-intelligence system. You are "
    "given a QUESTION, a REFERENCE answer (ground truth), the system's CANDIDATE "
    "answer, and the EVIDENCE passages the system retrieved. Score the CANDIDATE "
    "on four dimensions, each from 0.0 (worst) to 1.0 (best):\n"
    "- correctness: does it agree with the REFERENCE on the key facts? Contradictions score low.\n"
    "- groundedness: is every claim supported by the EVIDENCE? Invented/unsupported claims score low.\n"
    "- completeness: does it cover the key points the REFERENCE makes?\n"
    "- citation_quality: are the cited records the correct, supporting ones?\n"
    "Be strict and calibrated. Respond with ONLY a JSON object and no prose, of the form:\n"
    '{"correctness": 0.0, "groundedness": 0.0, "completeness": 0.0, '
    '"citation_quality": 0.0, "justification": "one or two sentences"}'
)


class JudgeUnavailable(Exception):
    """The judge backend could not be reached (treat like the answer model being down)."""


def looks_like_backend_down(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(h in msg for h in _CONN_HINTS)


def build_judge_prompt(question: str, golden: str, answer: str, evidence: list[str]) -> str:
    ev = "\n\n".join(f"[{i + 1}] {e}" for i, e in enumerate(evidence[:6])) or "(no evidence retrieved)"
    return (
        f"QUESTION:\n{question}\n\n"
        f"REFERENCE ANSWER:\n{golden}\n\n"
        f"CANDIDATE ANSWER:\n{answer or '(the system produced no answer)'}\n\n"
        f"EVIDENCE PASSAGES:\n{ev}\n\n"
        "Score the CANDIDATE now. Return only the JSON object."
    )


def parse_judge_json(raw: str) -> dict:
    """Pull the rubric JSON out of a model's reply and clamp each score to [0, 1].

    Tolerates markdown fences and surrounding prose by extracting the first
    balanced ``{...}`` object. Raises ValueError if no scores can be recovered."""
    text = raw.strip()
    # Prefer a fenced ```json block, else the first {...} span.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fence.group(1) if fence else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        candidate = text[start : end + 1] if 0 <= start < end else None
    if candidate is None:
        raise ValueError("no JSON object in judge output")
    data = json.loads(candidate)

    def clamp(x) -> float:
        try:
            return max(0.0, min(1.0, float(x)))
        except (TypeError, ValueError):
            return 0.0

    scores = {dim: clamp(data.get(dim)) for dim in RUBRIC_DIMS}
    justification = str(data.get("justification", "")).strip()[:600]
    return {**scores, "justification": justification}


class MockJudge:
    """Deterministic, offline judge using token-overlap heuristics.

    Not a real quality signal, but bounded, sensible and reproducible so the demo,
    tests and CI exercise the whole judge+composite path with no model."""

    name = "mock/mock"

    def judge(self, *, question: str, golden: str, answer: str, evidence: list[str]) -> dict:
        a = _terms(answer)
        g = _terms(golden)
        e = _terms("\n".join(evidence))
        correctness = _f1(a, g)
        completeness = _recall(g, a)          # how much of the reference the answer covers
        groundedness = _recall(a, e) if a else 0.0  # how much of the answer the evidence supports
        cited = set(re.findall(r"\[[^\]]+\]", answer))
        citation_quality = 1.0 if cited and evidence else (0.5 if answer else 0.0)
        return {
            "correctness": round(correctness, 3),
            "groundedness": round(groundedness, 3),
            "completeness": round(completeness, 3),
            "citation_quality": round(citation_quality, 3),
            "justification": (
                f"heuristic: term-F1 vs reference {correctness:.2f}, "
                f"evidence support {groundedness:.2f}, reference coverage {completeness:.2f}."
            ),
        }


class LlmJudge:
    """Wraps a real answer-model client and drives it as a rubric judge."""

    def __init__(self, client) -> None:
        self._client = client
        self.name = client.name

    def judge(self, *, question: str, golden: str, answer: str, evidence: list[str]) -> dict:
        request = SynthesisRequest(
            question=question,
            system_prompt=JUDGE_SYSTEM,
            user_prompt=build_judge_prompt(question, golden, answer, evidence),
        )
        try:
            raw = self._client.synthesize(request)
        except Exception as exc:  # noqa: BLE001
            if looks_like_backend_down(exc):
                raise JudgeUnavailable(str(exc)) from exc
            raise
        return parse_judge_json(raw)


def build_judge(settings: Settings):
    """Construct the judge named by the [eval] config, falling back to the answer
    model's backend/model/host when a judge-specific value is not set."""
    backend = (settings.eval_judge_backend or settings.llm_backend).lower()
    if backend == "mock":
        return MockJudge()
    model = settings.eval_judge_model or settings.llm_model
    if backend == "ollama":
        host = settings.eval_judge_host or settings.ollama_llm_host
        return LlmJudge(OllamaLLM(
            host=host, model=model, timeout_s=settings.llm_timeout_s,
            num_ctx=settings.llm_num_ctx, think=False, num_predict=512,
        ))
    if backend == "anthropic":
        return LlmJudge(AnthropicLLM(model=model, timeout_s=settings.llm_timeout_s))
    raise ValueError(f"unknown judge backend {backend!r} (use mock|ollama|anthropic)")


# ── token heuristics for the mock judge ──────────────────────────────────────
_WORD = re.compile(r"[a-z0-9][a-z0-9\-]{2,}")
_STOP = {
    "the", "and", "for", "was", "were", "that", "this", "with", "from", "into",
    "have", "has", "are", "not", "which", "what", "when", "who", "why", "how",
    "its", "his", "her", "their", "they", "than", "then", "been", "being", "also",
}


def _terms(text: str) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if w not in _STOP}


def _recall(target: set[str], have: set[str]) -> float:
    if not target:
        return 1.0
    return len(target & have) / len(target)


def _f1(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    prec = inter / len(a)
    rec = inter / len(b)
    return 2 * prec * rec / (prec + rec)
