"""Blind LLM judge for the evaluation harness.

Scores a candidate answer 0/1/2 against the gold answer, and flags hallucination,
using whichever answer model is configured for judging. This mirrors the scoring
protocol used to produce the reference architecture benchmarks. It is optional:
the deterministic metrics in ``run_eval.py`` need no judge.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from hde.config import Settings  # noqa: E402
from hde.llm import SynthesisRequest, build_llm  # noqa: E402

JUDGE_PROMPT = """You are a strict, blind evaluator for an engineering-knowledge QA system.
Score the CANDIDATE answer against the GOLD answer.

QUESTION: {question}
CATEGORY: {category}
GOLD ANSWER: {gold}
CANDIDATE ANSWER: {candidate}

Rules:
- score 2: matches gold on every key fact (ids, dates, names, causal chain).
- score 1: partially correct — right direction but missing/wrong on some key facts.
- score 0: wrong, irrelevant, or fabricated.
- For category "negative" the correct behaviour is to decline: score 2 if the
  candidate clearly says the information is not available, 0 if it invents an
  answer, 1 if it hedges ambiguously.
- hallucinated: true if the candidate asserts specific facts (ids, dates, names)
  neither in the gold answer nor plausibly generic.

Reply with ONLY this JSON: {{"score": 0|1|2, "hallucinated": true|false}}"""


class LLMJudge:
    def __init__(self, backend: str, model: str | None) -> None:
        settings = Settings(llm_backend=backend, llm_model=model or "claude-opus-4-8")
        self.llm = build_llm(settings)

    def score(self, question: str, category: str, gold: str, candidate: str) -> tuple[int | None, bool | None]:
        prompt = JUDGE_PROMPT.format(
            question=question, category=category, gold=gold,
            candidate=candidate or "(no answer)",
        )
        raw = self.llm.synthesize(
            SynthesisRequest(question=question, system_prompt="", user_prompt=prompt)
        )
        try:
            start, end = raw.find("{"), raw.rfind("}") + 1
            obj = json.loads(raw[start:end])
            return int(obj["score"]), bool(obj.get("hallucinated", False))
        except Exception:
            return None, None
