#!/usr/bin/env python3
"""Calibrate the deterministic gate against the demo corpus.

Runs retrieval + the gate's signal computation over every gold question and a set
of deliberately off-corpus probes, then prints the signal distributions so the
answer/decline boundary can be set from data rather than guesswork.

    python eval/calibrate_gate.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

from hde import gate as gate_mod  # noqa: E402
from hde.config import get_settings  # noqa: E402
from hde.embeddings import build_embedder  # noqa: E402
from hde.graph import KnowledgeGraph  # noqa: E402
from hde import store  # noqa: E402
from hde.retrieval import retrieve  # noqa: E402

OFF_CORPUS = [
    "What is the maximum cruise altitude of the Boeing 747?",
    "How do I bake a sourdough loaf at high altitude?",
    "What were the quarterly earnings of the company last year?",
    "Explain the offside rule in football.",
    "What is the recommended tyre pressure for a mountain bike?",
    "Who won the 2019 world chess championship?",
]


def main() -> None:
    settings = get_settings()
    conn = store.connect(settings.db_path)
    kg = KnowledgeGraph(conn)
    embedder = build_embedder(settings)

    qa = json.loads((REPO / "eval" / "gold-qa.json").read_text())

    def signals_for(question: str) -> dict:
        chunks, _ = retrieve(conn, kg, embedder, question, settings)
        return gate_mod.compute_signals(conn, question, chunks)

    print(f"{'id':<18} {'category':<11} {'cov':>5} {'anchor':>6} {'top':>7} {'strong':>6}  verdict")
    print("-" * 72)
    by_cat: dict[str, list[float]] = {}
    for q in qa:
        s = signals_for(q["question"])
        v = gate_mod.decide(s)
        by_cat.setdefault(q["category"], []).append(s["term_coverage"])
        print(f"{q['id']:<18} {q['category']:<11} {s['term_coverage']:>5} "
              f"{str(s['id_anchor']):>6} {s['top_score']:>7} {s['n_strong']:>6}  {v}")

    print("\n--- off-corpus probes (should be 'insufficient') ---")
    for probe in OFF_CORPUS:
        s = signals_for(probe)
        v = gate_mod.decide(s)
        print(f"{'OFF':<18} {'off-corpus':<11} {s['term_coverage']:>5} "
              f"{str(s['id_anchor']):>6} {s['top_score']:>7} {s['n_strong']:>6}  {v}  | {probe[:40]}")

    print("\n--- term_coverage by category (min / mean / max) ---")
    for cat, vals in sorted(by_cat.items()):
        print(f"  {cat:<12} min={min(vals):.3f}  mean={sum(vals)/len(vals):.3f}  max={max(vals):.3f}")
    conn.close()


if __name__ == "__main__":
    main()
