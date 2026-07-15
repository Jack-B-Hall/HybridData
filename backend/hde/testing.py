"""Health testing: a curated golden-set of questions, asked through the real
engine, graded deterministically (no LLM judge), as a background job.

Design mirrors :mod:`hde.ingestion`:

* One run at a time — :meth:`TestManager.start` rejects a concurrent start.
* The run happens on a daemon thread; the page polls :meth:`status` and can be
  left (fire-and-forget). Results land in the telemetry DB, which survives corpus
  clears/rebuilds — the same store the golden questions live in.
* Grading is deterministic: expected behaviour (answered vs refused, from the
  gate verdict), expected citation artifact-ids present, and expected keywords
  present (case-insensitive) in the answer. No model judges the output.
* If the answer model is unreachable (e.g. the Ollama host is off), the run ends
  cleanly marked ``error`` with a clear message — it never hangs.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .config import REPO_ROOT

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
        out.append({
            "text": q["question"],
            "category": category,
            "behaviour": "refuse" if category == "negative" else "answer",
            "citations": q.get("required_citation_ids", []),
            "keywords": [],
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


def grade(question: dict, result) -> tuple[bool, list[str]]:
    """Deterministic pass/fail + the list of failed-check reasons for one question."""
    failed: list[str] = []

    if question["behaviour"] == "refuse":
        if result.answered:
            failed.append("expected a refusal (out of scope) but the app answered")
    else:
        if not result.answered:
            failed.append("expected an answer but the app refused")

    # Content checks only make sense when we wanted (and got) an answer.
    if question["behaviour"] == "answer" and result.answered:
        want_ids = question.get("citations") or []
        if want_ids:
            got = {c.get("artifact_id") for c in result.citations}
            missing = [cid for cid in want_ids if cid not in got]
            if missing:
                failed.append("missing expected citations: " + ", ".join(missing))
        want_kw = question.get("keywords") or []
        if want_kw:
            text = (result.answer or "").lower()
            missing_kw = [k for k in want_kw if k.lower() not in text]
            if missing_kw:
                failed.append("missing expected keywords: " + ", ".join(missing_kw))

    return (not failed), failed


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
        backend = self.engine.llm.name
        results: list[dict] = []
        latencies: list[int] = []
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
                results.append({
                    "question_id": q["id"], "question": q["text"], "category": q["category"],
                    "behaviour": q["behaviour"], "answered": None, "verdict": None,
                    "passed": 0, "failed_checks": [f"engine error: {exc}"],
                    "latency_ms": None, "error": str(exc),
                })
                failed += 1
                continue

            ok, reasons = grade(q, res)
            passed += int(ok)
            failed += int(not ok)
            latencies.append(res.latency_ms)
            results.append({
                "question_id": q["id"], "question": q["text"], "category": q["category"],
                "behaviour": q["behaviour"], "answered": int(res.answered), "verdict": res.verdict,
                "passed": int(ok), "failed_checks": reasons, "latency_ms": res.latency_ms,
                "error": None,
            })
            self._set(passed=passed, failed=failed)

        answered_q = [q for q, r in zip(questions, results) if q["behaviour"] == "answer"]
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

        run = {
            "started_at": self._status.started_at, "finished_at": _now(),
            "status": "error" if run_error else "ok", "backend": backend, "scope": scope,
            "total": len(questions), "passed": passed, "failed": failed,
            "answer_rate": answer_rate, "refusal_rate": refusal_rate,
            "mean_latency_ms": mean_latency,
            "duration_ms": int((time.time() - t0) * 1000), "error": run_error,
        }
        run_id = self.engine.telemetry.log_test_run(run, results)
        self._set(
            running=False, stage="error" if run_error else "done",
            status="error" if run_error else "ok", error=run_error,
            finished_at=run["finished_at"], done=len(results), run_id=run_id,
        )
