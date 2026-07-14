#!/usr/bin/env python3
"""Evaluation harness for the hde engine.

Scores the engine against the 40-question gold set (``eval/gold-qa.json``) so any
change to retrieval, the graph, the gate, or synthesis can be measured. Two tiers
of metric:

* **Deterministic** (always run, no LLM needed): retrieval recall of the required
  citations, answer citation precision/recall, gate-verdict distribution, and
  refusal accuracy on the negative (unanswerable) questions. These measure the
  retrieval + graph + gate core directly and run fully offline.
* **Semantic** (optional, ``--judge``): a blind LLM judge scores each answer 0/1/2
  against the gold answer, exactly as the reference bake-off did. Requires a real
  answer model configured for the judge (Anthropic or Ollama).

Usage:
    python eval/run_eval.py                 # deterministic metrics, offline
    python eval/run_eval.py --judge anthropic --judge-model claude-...   # + semantic

Note: the default answer backend is the deterministic mock, whose answers are
grounded but terse; semantic scores are only meaningful with a real answer model
(set HDE_LLM_BACKEND=ollama|anthropic before running with --judge).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

from hde.config import get_settings  # noqa: E402
from hde.engine import Engine  # noqa: E402

CATEGORIES = ["provenance", "dependency", "impact", "lookup", "negative"]


def _prf(retrieved: set[str], required: set[str]) -> tuple[float | None, float | None]:
    if not required:
        return (None, None)
    if not retrieved:
        return (0.0, 0.0)
    tp = len(retrieved & required)
    return (tp / len(retrieved), tp / len(required))


def run(judge_backend: str | None, judge_model: str | None) -> dict:
    settings = get_settings()
    engine = Engine(settings)
    qa = json.loads((REPO / "eval" / "gold-qa.json").read_text())

    judge = None
    if judge_backend:
        from judge import LLMJudge  # local module

        judge = LLMJudge(judge_backend, judge_model)

    rows: list[dict] = []
    for q in qa:
        required = set(q.get("required_citation_ids", []))
        result = engine.ask(q["question"])

        source_ids = {s["artifact_id"] for s in result.sources}
        cited_ids = {c["artifact_id"] for c in result.citations}
        ret_p, ret_r = _prf(source_ids, required)   # did retrieval surface the evidence?
        cit_p, cit_r = _prf(cited_ids, required)     # did the answer cite it?

        is_negative = q["category"] == "negative"
        # Correct refusal only counts for negatives whose gold answer is truly
        # off-corpus; trap negatives (entity present) are expected to be answered.
        refused = not result.answered

        record = {
            "id": q["id"], "category": q["category"],
            "verdict": result.verdict, "answered": result.answered,
            "retrieval_recall": ret_r, "retrieval_precision": ret_p,
            "citation_recall": cit_r, "citation_precision": cit_p,
            "refused": refused,
        }
        if judge is not None:
            record["score"], record["hallucinated"] = judge.score(
                q["question"], q["category"], q["gold_answer"], result.answer
            )
        rows.append(record)
        print(f"  {q['id']:<5} {q['category']:<11} verdict={result.verdict:<12} "
              f"ret_recall={_fmt(ret_r)} cit_recall={_fmt(cit_r)}"
              + (f" score={record.get('score')}" if judge else ""))

    engine.close()
    return summarise(rows, judged=judge is not None)


def _fmt(x: float | None) -> str:
    return "  -  " if x is None else f"{x:.2f}"


def summarise(rows: list[dict], *, judged: bool) -> dict:
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)

    def _avg(vals: list[float | None]) -> float | None:
        real = [v for v in vals if v is not None]
        return round(sum(real) / len(real), 3) if real else None

    per_category = {}
    for cat in CATEGORIES:
        crs = by_cat.get(cat, [])
        if not crs:
            continue
        entry = {
            "n": len(crs),
            "retrieval_recall": _avg([r["retrieval_recall"] for r in crs]),
            "citation_recall": _avg([r["citation_recall"] for r in crs]),
            "citation_precision": _avg([r["citation_precision"] for r in crs]),
        }
        if cat == "negative":
            entry["refused_rate"] = round(sum(r["refused"] for r in crs) / len(crs), 3)
        if judged:
            entry["semantic_pct"] = _avg([r["score"] / 2 * 100 for r in crs if r.get("score") is not None])
        per_category[cat] = entry

    verdicts: dict[str, int] = defaultdict(int)
    for r in rows:
        verdicts[r["verdict"]] += 1

    overall = {
        "n": len(rows),
        "retrieval_recall": _avg([r["retrieval_recall"] for r in rows]),
        "citation_recall": _avg([r["citation_recall"] for r in rows]),
        "citation_precision": _avg([r["citation_precision"] for r in rows]),
        "verdict_distribution": dict(verdicts),
    }
    if judged:
        overall["semantic_pct"] = _avg([r["score"] / 2 * 100 for r in rows if r.get("score") is not None])
        overall["hallucination_rate"] = round(
            sum(1 for r in rows if r.get("hallucinated")) / len(rows), 3)
    return {"overall": overall, "per_category": per_category, "rows": rows}


def write_reports(summary: dict, judged: bool) -> None:
    out = REPO / "eval" / "results"
    out.mkdir(exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=2))

    o = summary["overall"]
    lines = [
        "# hde evaluation summary", "",
        f"- Questions: **{o['n']}**",
        f"- Retrieval recall (required citations surfaced): **{o['retrieval_recall']}**",
        f"- Citation recall (answer): **{o['citation_recall']}**  "
        f"| precision: **{o['citation_precision']}**",
        f"- Gate verdicts: {o['verdict_distribution']}",
    ]
    if judged:
        lines.append(f"- Semantic score (LLM judge): **{o.get('semantic_pct')}%**  "
                     f"| hallucination rate: {o.get('hallucination_rate')}")
    lines += ["", "## Per category", "",
              "| category | n | retrieval recall | citation recall | citation precision |"
              + (" semantic % |" if judged else " |"),
              "|---|---|---|---|---|" + ("---|" if judged else "")]
    for cat, e in summary["per_category"].items():
        row = (f"| {cat} | {e['n']} | {e['retrieval_recall']} | {e['citation_recall']} "
               f"| {e['citation_precision']} |")
        if judged:
            row += f" {e.get('semantic_pct')} |"
        lines.append(row)
        if cat == "negative":
            lines.append(f"| _negative refusal rate_ | | | {e.get('refused_rate')} | |"
                         + (" |" if judged else ""))
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n" + "\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge", choices=["anthropic", "ollama"], help="enable the LLM judge")
    ap.add_argument("--judge-model", help="judge model id")
    args = ap.parse_args()
    summary = run(args.judge, args.judge_model)
    write_reports(summary, judged=args.judge is not None)


if __name__ == "__main__":
    main()
