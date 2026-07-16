"""Health testing: a curated golden-set of questions, asked through the real
engine, then scored on TWO axes and combined into one composite score, as a
background job.

Design mirrors :mod:`hde.ingestion`:

* One run at a time — :meth:`TestManager.start` rejects a concurrent start.
* The run happens on a daemon thread; the page polls :meth:`status` and can be
  left (fire-and-forget). Results land in the telemetry DB, which survives corpus
  clears/rebuilds — the same store the golden questions live in.
* If the answer model (or a separate judge model) is unreachable, the run ends
  cleanly marked ``error`` with a clear message — it never hangs.

Scoring (see :func:`retrieval_score`, :func:`composite_score`):

* **Retrieval sub-score** (deterministic, 0-1) — did it get the behaviour right
  (answered vs refused) and surface the expected citations/keywords? This is the
  "found and cited the right documents" axis.
* **Answer quality** — when a golden answer is present and a judge is available,
  an LLM-as-judge (:mod:`hde.judge`) scores the produced answer against the golden
  answer + retrieved evidence on a rubric (correctness / groundedness /
  completeness / citation quality).
* **Composite (0-100)** — a configurable weighted blend of the retrieval sub-score
  and the judge's correctness / groundedness / completeness. With no golden answer
  or no judge, it degrades gracefully to the deterministic retrieval sub-score.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .config import REPO_ROOT
from .judge import RUBRIC_DIMS, JudgeUnavailable, build_judge

BEHAVIOURS = ("answer", "refuse")

# Errors that mean the answer backend is unreachable rather than a real failure
# of an individual question — we abort the run with a clear message instead of
# recording every question as failed.
_CONN_HINTS = (
    "route to host", "connection refused", "connection reset", "timed out",
    "timeout", "failed to establish", "name or service not known",
    "urlopen error", "max retries", "no route",
)


class TestBusy(Exception):
    """A test run is already in progress."""

    __test__ = False  # not a pytest test class despite the name


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _looks_like_backend_down(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(h in msg for h in _CONN_HINTS)


def load_seed_questions() -> list[dict]:
    """The bundled demo gold set, mapped to golden_questions rows. Negatives are
    modelled as expected-refusal ('out of scope') questions. Absent file -> []."""
    path = REPO_ROOT / "eval" / "gold-qa.json"
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    out: list[dict] = []
    for q in raw:
        category = q.get("category", "general")
        refuse = category == "negative"
        out.append({
            "text": q["question"],
            "category": category,
            "behaviour": "refuse" if refuse else "answer",
            "citations": q.get("required_citation_ids", []),
            "keywords": [],
            # The gold file ships a reference answer per question; refuse cases
            # have nothing to match against, so they carry none.
            "golden_answer": None if refuse else q.get("gold_answer"),
            "enabled": True,
            "notes": "Seeded from the bundled demo gold set.",
        })
    return out


@dataclass
class RunStatus:
    running: bool = False
    stage: str = "idle"
    started_at: str | None = None
    finished_at: str | None = None
    status: str | None = None  # 'ok' | 'error' once finished
    error: str | None = None
    total: int = 0
    done: int = 0
    passed: int = 0
    failed: int = 0
    run_id: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Weights:
    """Composite-score weights. Retrieval is the deterministic axis; the other three
    are judge rubric dimensions. Normalised on use so the composite stays 0-100."""

    retrieval: float = 0.30
    correctness: float = 0.40
    groundedness: float = 0.20
    completeness: float = 0.10

    @classmethod
    def from_settings(cls, s) -> "Weights":
        return cls(s.eval_w_retrieval, s.eval_w_correctness,
                   s.eval_w_groundedness, s.eval_w_completeness)

    def as_dict(self) -> dict:
        return asdict(self)


def retrieval_score(question: dict, result) -> tuple[float, list[str]]:
    """Deterministic sub-score (0-1) + the failed-check reasons for one question.

    Behaviour is a gate: a wrong behaviour (answered when it should refuse, or vice
    versa) scores 0. Given the right behaviour, an ANSWER question is scored on the
    fraction of expected citations and keywords it surfaced (each neutral at 1.0
    when none are specified); a correct REFUSE scores 1.0."""
    failed: list[str] = []
    behaviour = question["behaviour"]

    if behaviour == "refuse":
        if result.answered:
            failed.append("expected a refusal (out of scope) but the app answered")
            return 0.0, failed
        return 1.0, failed

    # answer
    if not result.answered:
        failed.append("expected an answer but the app refused")
        return 0.0, failed

    parts: list[float] = []
    want_ids = question.get("citations") or []
    if want_ids:
        got = {c.get("artifact_id") for c in result.citations}
        missing = [cid for cid in want_ids if cid not in got]
        parts.append((len(want_ids) - len(missing)) / len(want_ids))
        if missing:
            failed.append("missing expected citations: " + ", ".join(missing))
    want_kw = question.get("keywords") or []
    if want_kw:
        text = (result.answer or "").lower()
        missing_kw = [k for k in want_kw if k.lower() not in text]
        parts.append((len(want_kw) - len(missing_kw)) / len(want_kw))
        if missing_kw:
            failed.append("missing expected keywords: " + ", ".join(missing_kw))

    return (sum(parts) / len(parts) if parts else 1.0), failed


def composite_score(retrieval: float, judge_dims: dict | None, weights: Weights) -> float:
    """Blend the retrieval sub-score with the judge rubric into a 0-100 score.

    Weights are normalised so the result is always 0-100. With no judge (refuse
    questions, no golden answer, or judge unavailable) this is just the retrieval
    sub-score scaled to 100 — the graceful, deterministic-only path. The judge's
    ``citation_quality`` is reported for transparency but not weighted here, since
    citations are already scored deterministically in the retrieval sub-score."""
    if judge_dims is None:
        return round(100.0 * retrieval, 1)
    total = weights.retrieval + weights.correctness + weights.groundedness + weights.completeness
    if total <= 0:
        return round(100.0 * retrieval, 1)
    blended = (
        weights.retrieval * retrieval
        + weights.correctness * judge_dims["correctness"]
        + weights.groundedness * judge_dims["groundedness"]
        + weights.completeness * judge_dims["completeness"]
    ) / total
    return round(100.0 * blended, 1)


class TestManager:
    """Serialises golden-set test runs against the live engine."""

    __test__ = False  # not a pytest test class despite the name

    def __init__(self, engine) -> None:
        self.engine = engine
        self._lock = threading.Lock()
        self._status = RunStatus()
        self._thread: threading.Thread | None = None

    def seed_if_empty(self) -> int:
        """Populate the golden set from the bundled gold file on first ever run."""
        if self.engine.telemetry.golden_count():
            return 0
        return self.engine.telemetry.seed_golden(load_seed_questions())

    # ── queries ──────────────────────────────────────────────────────────────
    def status(self) -> dict:
        with self._lock:
            return self._status.as_dict()

    def history(self, limit: int = 25) -> list[dict]:
        return self.engine.telemetry.test_runs(limit)

    def run_detail(self, run_id: int) -> dict | None:
        return self.engine.telemetry.test_run(run_id)

    def scoring_config(self) -> dict:
        """The scoring methodology, surfaced so the UI can render it transparently:
        the rubric, the composite weights, the pass threshold, and which model
        judges (with a same-model-bias flag when the judge == the answer model)."""
        s = self.engine.settings
        same_model = s.eval_judge_backend is None and s.eval_judge_model is None
        return {
            "pass_threshold": s.eval_pass_threshold,
            "weights": Weights.from_settings(s).as_dict(),
            "rubric_dims": list(RUBRIC_DIMS),
            "judge": {
                "backend": (s.eval_judge_backend or s.llm_backend),
                "model": (s.eval_judge_model or s.llm_model),
                "same_as_answer_model": same_model,
            },
        }

    # ── control ──────────────────────────────────────────────────────────────
    def start(self, categories: list[str] | None = None) -> dict:
        with self._lock:
            if self._status.running:
                raise TestBusy("a test run is already in progress")
            questions = self.engine.telemetry.list_golden(enabled=True)
            if categories:
                wanted = set(categories)
                questions = [q for q in questions if q["category"] in wanted]
            scope = "all enabled" if not categories else "categories: " + ", ".join(sorted(set(categories)))
            self._status = RunStatus(
                running=True, stage="starting", started_at=_now(), total=len(questions)
            )
        self._thread = threading.Thread(target=self._run, args=(questions, scope), daemon=True)
        self._thread.start()
        return self.status()

    def _set(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    def _run(self, questions: list[dict], scope: str) -> None:
        t0 = time.time()
        settings = self.engine.settings
        backend = self.engine.llm.name
        weights = Weights.from_settings(settings)
        threshold = settings.eval_pass_threshold
        judge = build_judge(settings)
        results: list[dict] = []
        latencies: list[int] = []
        composites: list[float] = []
        passed = failed = 0
        run_error: str | None = None

        for i, q in enumerate(questions, start=1):
            self._set(stage=f"asking {i}/{len(questions)}", done=i - 1)
            try:
                res = self.engine.ask(q["text"])
            except Exception as exc:  # noqa: BLE001 — record, decide whether to abort
                if _looks_like_backend_down(exc):
                    run_error = f"answer backend unreachable ({backend}): {exc}"
                    break
                results.append(_error_result(q, f"engine error: {exc}", str(exc)))
                failed += 1
                self._set(failed=failed)
                continue

            ret, reasons = retrieval_score(q, res)

            # Judge answer quality when there's a golden answer to match against and
            # the app actually produced an answer to grade.
            judge_dims: dict | None = None
            golden = q.get("golden_answer")
            if q["behaviour"] == "answer" and res.answered and golden:
                self._set(stage=f"judging {i}/{len(questions)}")
                try:
                    evidence = [s.get("body", "") for s in res.sources[:6]]
                    judge_dims = judge.judge(
                        question=q["text"], golden=golden, answer=res.answer, evidence=evidence)
                except JudgeUnavailable as exc:
                    run_error = f"judge backend unreachable ({judge.name}): {exc}"
                    break
                except Exception as exc:  # noqa: BLE001 — bad judge output: degrade this one
                    reasons = [*reasons, f"judge output unusable: {exc}"]

            comp = composite_score(ret, judge_dims, weights)
            ok = comp >= threshold
            passed += int(ok)
            failed += int(not ok)
            latencies.append(res.latency_ms)
            composites.append(comp)
            results.append({
                "question_id": q["id"], "question": q["text"], "category": q["category"],
                "behaviour": q["behaviour"], "answered": int(res.answered), "verdict": res.verdict,
                "passed": int(ok), "failed_checks": reasons, "retrieval_score": round(ret, 3),
                "judged": int(judge_dims is not None),
                "judge_correctness": judge_dims["correctness"] if judge_dims else None,
                "judge_groundedness": judge_dims["groundedness"] if judge_dims else None,
                "judge_completeness": judge_dims["completeness"] if judge_dims else None,
                "judge_citation": judge_dims["citation_quality"] if judge_dims else None,
                "judge_justification": judge_dims["justification"] if judge_dims else None,
                "composite": comp, "latency_ms": res.latency_ms, "error": None,
            })
            self._set(passed=passed, failed=failed)

        refuse_results = [r for r in results if r["behaviour"] == "refuse"]
        answer_results = [r for r in results if r["behaviour"] == "answer"]
        answer_rate = (
            sum(1 for r in answer_results if r["answered"]) / len(answer_results)
            if answer_results else None
        )
        refusal_rate = (
            sum(1 for r in refuse_results if r["answered"] == 0) / len(refuse_results)
            if refuse_results else None
        )
        mean_latency = int(sum(latencies) / len(latencies)) if latencies else None
        mean_composite = round(sum(composites) / len(composites), 1) if composites else None
        any_judged = any(r["judged"] for r in results)

        run = {
            "started_at": self._status.started_at, "finished_at": _now(),
            "status": "error" if run_error else "ok", "backend": backend,
            "judge_backend": judge.name if any_judged else None, "scope": scope,
            "total": len(questions), "passed": passed, "failed": failed,
            "answer_rate": answer_rate, "refusal_rate": refusal_rate,
            "mean_composite": mean_composite, "mean_latency_ms": mean_latency,
            "duration_ms": int((time.time() - t0) * 1000), "error": run_error,
        }
        run_id = self.engine.telemetry.log_test_run(run, results)
        self._set(
            running=False, stage="error" if run_error else "done",
            status="error" if run_error else "ok", error=run_error,
            finished_at=run["finished_at"], done=len(results), run_id=run_id,
        )


def _error_result(q: dict, reason: str, error: str) -> dict:
    return {
        "question_id": q["id"], "question": q["text"], "category": q["category"],
        "behaviour": q["behaviour"], "answered": None, "verdict": None,
        "passed": 0, "failed_checks": [reason], "retrieval_score": None,
        "judged": 0, "judge_correctness": None, "judge_groundedness": None,
        "judge_completeness": None, "judge_citation": None, "judge_justification": None,
        "composite": None, "latency_ms": None, "error": error,
    }
