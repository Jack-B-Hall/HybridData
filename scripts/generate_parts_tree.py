#!/usr/bin/env python3
"""Generate data/parts-tree.json (a nested assembly tree) from the flat demo parts.

This produces a self-contained example for the JsonTreeAdapter and for the graph
hierarchy story. Run once; the output is committed as demo data.

    python scripts/generate_parts_tree.py
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PARTS_DIR = REPO / "data" / "demo-corpus" / "parts"
OUT = REPO / "data" / "parts-tree.json"


def main() -> None:
    parts = {}
    for path in sorted(PARTS_DIR.glob("*.json")):
        p = json.loads(path.read_text())
        s = p.get("structured", {})
        parts[p["id"]] = {
            "id": p["id"],
            "title": p["title"],
            "subsystem": s.get("subsystem"),
            "material": s.get("material"),
            "mass_g": s.get("mass_g"),
            "text": p.get("text", ""),
            "parent_id": s.get("parent_id"),
            "children": [],
        }

    roots = []
    for pid, node in parts.items():
        parent = node.pop("parent_id")
        if parent and parent in parts:
            parts[parent]["children"].append(node)
        else:
            roots.append(node)

    # Synthesise a single product root so the tree has one top assembly.
    tree = {
        "id": "K-200",
        "title": "Kestrel K-200 (product)",
        "subsystem": "Product",
        "text": "Autonomous maritime survey drone. Top-level product assembly.",
        "children": roots,
    }
    OUT.write_text(json.dumps(tree, indent=2))
    n = len(parts) + 1
    print(f"wrote {OUT} with {n} nodes ({len(roots)} top-level assemblies)")


if __name__ == "__main__":
    main()
