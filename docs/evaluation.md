# Evaluation

The engine ships with a 40-question gold set (`eval/gold-qa.json`) and a harness
so any change to retrieval, the graph, the gate, or synthesis can be scored. The
gold set covers five categories: provenance (10), dependency (10), impact (10),
lookup (5), and negative (5 — unanswerable, testing refusal).

## Running it

```bash
make eval                       # deterministic metrics, fully offline
# or
python eval/run_eval.py
```

This reports two deterministic, LLM-free metrics that measure the retrieval +
graph + gate core directly:

- **Retrieval recall** — fraction of each question's required-citation records that
  the fused retriever surfaced. This is the cleanest measure of the core, because
  it is independent of the answer model.
- **Citation precision / recall** — how well the *answer* cited the required
  records. With the default deterministic mock answer model this is a floor (the
  mock cites only its top sources); a real answer model lifts it toward the
  retrieval-recall ceiling.

Plus the gate's verdict distribution and the refusal rate on negatives.

### Semantic scoring (optional)

To score answer quality, enable the blind LLM judge (0/1/2 against the gold
answer), which mirrors the protocol used for the reference benchmarks below:

```bash
HDE_LLM_BACKEND=ollama HDE_LLM_MODEL=gemma3:12b \
  python eval/run_eval.py --judge ollama --judge-model gemma3:12b
```

Semantic scores are only meaningful with a real answer model configured
(`HDE_LLM_BACKEND=ollama|anthropic`); the mock's answers are grounded but terse
by design.

## Demo baseline (offline: hash embedder + mock answer model)

Produced by `make eval` on the bundled demo corpus with zero external services.
These isolate the retrieval/graph/gate core:

| category | retrieval recall | citation recall |
|---|---|---|
| provenance | 0.79 | 0.40 |
| dependency | 0.47 | 0.30 |
| impact | 0.56 | 0.30 |
| lookup | 0.70 | 0.60 |
| **overall** | **0.62** | **0.37** |

Gate on the gold set: all real questions pass the gate (no false refusals — the
anti-over-refusal design goal), and genuine off-corpus probes are declined (see
`eval/calibrate_gate.py`, which shows 5/6 off-corpus probes correctly refused).
The 5 gold negatives are *trap* negatives — they name a real record but ask for an
attribute that was never recorded — and are deliberately undetectable from
retrieval alone; catching them relies on the grounded-refusal instruction in
synthesis, which requires a real answer model.

The hash embedder captures lexical overlap, not semantics. Swapping in
`nomic-embed-text` (`HDE_EMBEDDER=ollama`) helps the semantically-phrased
dependency and impact questions (dependency recall 0.47 → 0.54, impact 0.56 →
0.62) but is roughly **neutral on aggregate** (0.62 → 0.62) on this corpus:
record ids and exact terms are so dense that the exact-id and BM25 legs already
surface most evidence, and semantic matching can even displace an exact
provenance hit (provenance 0.79 → 0.65). The embedder matters more on prose-heavy
corpora with less lexical overlap.

## Live-model validation

The pipeline was exercised end-to-end against a real western-origin stack —
**gemma4:26b-a4b-it-qat** (Google) as the answer model with **nomic-embed-text**
(Nomic AI) embeddings — through the UI across provenance, impact, lookup, and
off-corpus (refusal) questions. Answers were fluent and correctly grounded, with
citations resolving to the exact passages and the gate declining the off-corpus
probe. Real models emit markdown, LaTeX, and inconsistent citation formats; the
synthesis layer normalises all of these (see `hde/synthesis.py`) so the answer
renders as clean prose with numeric citation chips regardless of model. Latency
was ~8-14 s per answer on a single 16 GB GPU — streamed token-by-token so the
answer appears as it is generated rather than after a wall of latency. See the
live screenshots in `docs/screenshots/03-answer-done-light.png`,
`02-staged-streaming-light.png`, and `04-source-drawer-light.png`.

On a 10-question live slice (`python eval/run_eval.py --limit 10`) with this
stack, **citation recall rose to 0.67** — up from the deterministic mock's 0.35 on
the same store, and now closely tracking retrieval recall (0.69). In other words,
the real answer model cites nearly everything the retriever surfaces; the mock's
low citation recall was a floor of the stand-in, not a limitation of the pipeline.
The gate held (no false refusals on answerable questions).

## Reference architecture benchmarks

For context, this architecture class was measured in a controlled bake-off with a
real answer model, scored by a blind frontier-model judge. With a **gemma-class
local model (~12-31B)** the fused-retrieval + gate architecture reached roughly
**68% overall** answer quality with **~0.84 citation recall**; with a **frontier
model as the ceiling** it reached **~80% overall** with **~0.87 citation recall** —
the best capability ceiling of any architecture tested, and about **2:1 better
citation grounding than plain vector RAG**. Provenance questions scored highest
(~90%); impact/dependency were the hardest category for every architecture, which
is exactly why the hierarchical graph backbone and precomputed closures exist.

Reproduce the answer-quality figures locally by pointing the answer model and
judge at a real backend and running `python eval/run_eval.py --judge ...`.

## Adding questions

Append to `eval/gold-qa.json`:

```json
{ "id": "Q41", "category": "impact",
  "question": "...", "gold_answer": "...",
  "required_citation_ids": ["ECR-214", "ECN-312"] }
```

`required_citation_ids` drives the deterministic retrieval/citation metrics;
`gold_answer` is used only by the optional judge.
