# Adding a data source

Teaching the system a new source means writing one small adapter. Everything
downstream — chunking, embedding, graph construction, provenance tagging, impact
closures — is handled by the runner, identically for every source. A typical
adapter is well under 50 lines.

## The contract

Subclass `SourceAdapter` and yield `Record` objects:

```python
from hde.ingest import Record, Relation, SourceAdapter

class TicketsAdapter(SourceAdapter):
    source = "Jira"                      # provenance label -> tier (see hde.provenance)

    def __init__(self, path):
        self.path = path

    def records(self):
        for row in load_rows(self.path):         # <- your source of truth
            yield Record(
                id=row["key"],                    # stable unique id (also the graph node id)
                kind="document",                  # "entity" | "document" | "person"
                title=row["summary"],
                text=row["description"],
                refs=row["links"],                # ids this record references
                relations=[Relation("TRIGGERS", row["change_id"])],  # optional typed edges
                subsystem=row.get("component"),
                metadata=row,                     # preserved verbatim for the UI
            )
```

### `Record` fields

| field | meaning |
|---|---|
| `id` | stable unique identifier; also the knowledge-graph node id |
| `kind` | `"entity"` (a node in the hierarchy — a part, assembly, org unit), `"document"` (a leaf artifact), or `"person"` |
| `title` | short label |
| `text` | full searchable prose (may be empty for pure entities) |
| `source` | provenance label; maps to a tier. Defaults to the adapter's `source` |
| `parent_id` | for entities, the parent in the hierarchy — this builds the `PART_OF` backbone |
| `refs` | ids this record references; drives impact/dependency closures and untyped edges |
| `relations` | optional typed graph edges (`Relation(rel, target_id)`) |
| `subsystem` | optional grouping used by the explorer filters |
| `metadata` | arbitrary dict, preserved for display |

Rules of thumb:

- Make **structural** things (a part, an assembly, a folder, a team) `entity`
  records and give them a `parent_id`. That is the graph's backbone.
- Make **content** things (a spec, ticket, note, drawing, commit) `document`
  records and connect them to the entities they describe via `refs` / `relations`.
- Set `source` so the record lands in the right provenance tier. Add new source
  labels to `SOURCE_TIER` in `hde/provenance.py`.
- Use `refs` when you only need a reference edge (closures, generic links); add a
  `Relation` when the edge *type* should show in the graph view.

## Registering and running it

For a one-off, ingest programmatically:

```python
from hde.config import get_settings
from hde.ingest import ingest

ingest(TicketsAdapter("tickets.db"), get_settings())      # reset=True rebuilds
```

To combine several sources into one store, pass a list (snapshot semantics apply
— a later record id supersedes an earlier one):

```python
ingest([PartsAdapter("parts/"), TicketsAdapter("tickets.db"), WikiAdapter("wiki/")],
       get_settings())
```

To wire it into the CLI, add a flag in `hde/cli.py:cmd_ingest` alongside the
built-ins.

## The bundled adapters

- `JsonCorpusAdapter` — the demo corpus (typed JSON artifacts). A good template
  for a non-trivial adapter: it derives typed relations and people deterministically
  from structured metadata. See `hde/ingest/json_corpus.py`.
- `MarkdownDirectoryAdapter` — a folder of `.md` files with optional front matter.
  The smallest realistic adapter. `data/examples/markdown-docs/` is a sample input.
- `JsonTreeAdapter` — a nested JSON hierarchy (`children` arrays) → parented entity
  records. `data/parts-tree.json` is a sample input.
- `CsvAdapter` — a CSV/TSV export with a configurable column map.
  `data/examples/tickets.csv` is a sample input.

Try them:

```bash
hde ingest --markdown data/examples/markdown-docs
hde ingest --json-tree data/parts-tree.json
hde ingest --csv data/examples/tickets.csv
```

## What the runner does with your records

1. **Provenance** — `source` → tier (formal / unverified / informal) on every
   record and chunk.
2. **Chunk + embed** — `text` is split into overlapping-free chunks with source
   spans, embedded, and written to the FTS5 and vector indexes.
3. **Graph** — a node per record; `PART_OF` edges from `parent_id`; typed edges
   from `relations`; `REFERENCES` edges from any remaining `refs`.
4. **Closures** — the forward (depends-on) and reverse (impacted-by) reference
   closures are precomputed per record so impact questions are a lookup.

No language model is required for ingestion; the demo corpus builds in well under
a second on CPU.
