"""Tests for the ingestion source adapters."""
from __future__ import annotations

import json

from hde.ingest.csv_adapter import ColumnMap, CsvAdapter
from hde.ingest.json_tree_adapter import JsonTreeAdapter
from hde.ingest.markdown_adapter import MarkdownDirectoryAdapter


def test_markdown_adapter_reads_front_matter(tmp_path):
    (tmp_path / "doc.md").write_text(
        "---\nid: DOC-9\ntitle: Cooling Spec\nsource: PLM\nrefs: P-1, P-2\n---\n"
        "# Cooling Spec\n\nThe coolant loop runs at 2 bar.\n"
    )
    recs = list(MarkdownDirectoryAdapter(tmp_path))
    assert len(recs) == 1
    r = recs[0]
    assert r.id == "DOC-9" and r.title == "Cooling Spec" and r.source == "PLM"
    assert r.refs == ["P-1", "P-2"]
    assert "coolant loop" in r.text


def test_markdown_adapter_defaults_without_front_matter(tmp_path):
    (tmp_path / "notes.md").write_text("# Design Notes\n\nSome content.\n")
    r = list(MarkdownDirectoryAdapter(tmp_path))[0]
    assert r.id == "notes" and r.title == "Design Notes" and r.source == "markdown"


def test_json_tree_adapter_builds_hierarchy(tmp_path):
    tree = {
        "id": "R", "title": "Root", "children": [
            {"id": "C1", "title": "Child 1", "subsystem": "A", "children": [
                {"id": "G1", "title": "Grandchild"},
            ]},
            {"id": "C2", "title": "Child 2"},
        ],
    }
    path = tmp_path / "tree.json"
    path.write_text(json.dumps(tree))
    recs = {r.id: r for r in JsonTreeAdapter(path)}
    assert recs["R"].parent_id is None
    assert recs["C1"].parent_id == "R" and recs["C1"].subsystem == "A"
    assert recs["G1"].parent_id == "C1"
    assert all(r.kind == "entity" for r in recs.values())


def test_csv_adapter_maps_columns(tmp_path):
    path = tmp_path / "rows.csv"
    path.write_text(
        "key,name,detail,links\n"
        "K-1,First,Some detail,K-2;K-3\n"
        "K-2,Second,More detail,\n"
    )
    cols = ColumnMap(id="key", title="name", text="detail", refs="links")
    recs = {r.id: r for r in CsvAdapter(path, cols)}
    assert recs["K-1"].title == "First" and recs["K-1"].refs == ["K-2", "K-3"]
    assert recs["K-2"].refs == []
    assert recs["K-1"].kind == "document"


def test_adapter_applies_default_source():
    from hde.ingest import Record, SourceAdapter

    class A(SourceAdapter):
        source = "custom"

        def records(self):
            yield Record("X-1", "document", "t", "body")

    assert list(A())[0].source == "custom"
