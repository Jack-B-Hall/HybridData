"""``hde`` command-line interface.

    hde ingest --demo                 build the store from the bundled demo corpus
    hde ingest --markdown DIR         ingest a directory of Markdown files
    hde ingest --json-tree FILE       ingest a nested JSON hierarchy
    hde ingest --csv FILE             ingest a CSV export
    hde ask "question"                answer one question from the store
    hde stats                         print corpus + graph statistics
    hde serve [--host H --port P]     run the HTTP API (uvicorn)

Storage location and backends are read from the environment (see hde.config).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import REPO_ROOT, get_settings


def _demo_corpus_dir() -> Path:
    return REPO_ROOT / "data" / "demo-corpus"


def cmd_ingest(args: argparse.Namespace) -> int:
    from .ingest import ingest
    from .ingest.csv_adapter import CsvAdapter
    from .ingest.json_corpus import JsonCorpusAdapter
    from .ingest.json_tree_adapter import JsonTreeAdapter
    from .ingest.markdown_adapter import MarkdownDirectoryAdapter

    settings = get_settings()
    adapters = []
    if args.demo:
        adapters.append(JsonCorpusAdapter(_demo_corpus_dir()))
    if args.markdown:
        adapters.append(MarkdownDirectoryAdapter(args.markdown))
    if args.json_tree:
        adapters.append(JsonTreeAdapter(args.json_tree))
    if args.csv:
        adapters.append(CsvAdapter(args.csv))
    if not adapters:
        print("nothing to ingest: pass --demo / --markdown / --json-tree / --csv", file=sys.stderr)
        return 2

    print(f"Ingesting into {settings.db_path} (embedder={settings.embedder})...")
    result = ingest(adapters, settings, reset=not args.append, progress=lambda m: print(m))
    print(
        f"\nDone: {result.n_records} records, {result.n_chunks} chunks, "
        f"{result.n_nodes} nodes, {result.n_edges} edges, {result.n_closures} closures."
    )
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    from .engine import open_engine

    engine = open_engine()
    result = engine.ask(args.question)
    if args.json:
        print(json.dumps(result.as_dict(), indent=2))
    else:
        print(f"\nQ: {result.question}")
        print(f"verdict: {result.verdict} (confidence: {result.confidence})  "
              f"backend: {result.backend}  {result.latency_ms}ms\n")
        print(result.answer)
        if result.citations:
            print("\nCitations:")
            for c in result.citations:
                mark = "grounded" if c["grounded"] else "unresolved"
                print(f"  [{c['marker']}] {c['artifact_id']} — {c['title']} ({mark})")
    engine.close()
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    from .engine import open_engine

    engine = open_engine()
    print(json.dumps(engine.corpus_stats(), indent=2))
    engine.close()
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("hde.api.app:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="hde", description="Hybrid-Data-Example engine")
    sub = p.add_subparsers(dest="command", required=True)

    ing = sub.add_parser("ingest", help="build/update the store from a source")
    ing.add_argument("--demo", action="store_true", help="ingest the bundled demo corpus")
    ing.add_argument("--markdown", metavar="DIR", help="ingest a directory of .md files")
    ing.add_argument("--json-tree", metavar="FILE", help="ingest a nested JSON hierarchy")
    ing.add_argument("--csv", metavar="FILE", help="ingest a CSV export")
    ing.add_argument("--append", action="store_true", help="add to the store instead of rebuilding")
    ing.set_defaults(func=cmd_ingest)

    ask = sub.add_parser("ask", help="answer one question")
    ask.add_argument("question")
    ask.add_argument("--json", action="store_true", help="print the full JSON result")
    ask.set_defaults(func=cmd_ask)

    st = sub.add_parser("stats", help="print corpus + graph statistics")
    st.set_defaults(func=cmd_stats)

    srv = sub.add_parser("serve", help="run the HTTP API")
    srv.add_argument("--host", default="127.0.0.1")
    srv.add_argument("--port", type=int, default=8000)
    srv.add_argument("--reload", action="store_true")
    srv.set_defaults(func=cmd_serve)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
