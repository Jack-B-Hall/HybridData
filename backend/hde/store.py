"""SQLite storage layer.

The entire system state lives in one SQLite file: lexical index, vector index,
knowledge graph, precomputed impact closures, and ingestion history. There is no
external database, message broker, or search service to run — ``pip install`` and
go. The vector index is provided by the ``sqlite-vec`` extension, which is loaded
per-connection.

Schema (snapshot-only: re-ingesting a record replaces the superseded version):

    meta             key/value: schema version, embedder, embed_dim, snapshot time
    artifacts        every record; kind = "entity" (a part/assembly node) or
                     "document" (a leaf artifact hung off the graph)
    refs             directed reference edges between artifacts (both directions
                     indexed) — the raw material for impact/dependency closures
    chunks           retrieval units, with a byte span back into the source text
    chunks_fts       FTS5 (BM25) over chunk body + title
    chunks_vec       sqlite-vec float[dim] embeddings, rowid-aligned to chunks
    graph_nodes      knowledge-graph nodes (entities, documents, people)
    graph_edges      typed knowledge-graph edges (PART_OF, DESCRIBES, ...)
    impact_closures  per-artifact forward/reverse ref closure + a readable summary
    ingest_runs      one row per ingestion, for the corpus-history view
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1


def connect(db_path: Path, *, create: bool = False, check_same_thread: bool = True) -> sqlite3.Connection:
    """Open a connection with the sqlite-vec extension loaded.

    Set ``create=True`` to allow creating a fresh database file; otherwise a
    missing file raises, so callers fail loudly instead of querying an empty DB.
    Pass ``check_same_thread=False`` for the read-only serving path, where the API
    shares one connection across the request threadpool (guarded by a lock).
    """
    import sqlite_vec

    if not create and not db_path.exists():
        raise FileNotFoundError(
            f"No hde database at {db_path}. Run `hde ingest` (or `make demo`) first."
        )
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def initialise(conn: sqlite3.Connection, embed_dim: int) -> None:
    """Create all tables/indexes on a fresh connection (idempotent)."""
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artifacts (
            id        TEXT PRIMARY KEY,
            kind      TEXT NOT NULL,          -- "entity" | "document"
            title     TEXT NOT NULL,
            text      TEXT NOT NULL,
            source    TEXT NOT NULL,
            prov_tier INTEGER NOT NULL,
            subsystem TEXT,
            parent_id TEXT,                   -- assembly parent for entities
            metadata  TEXT NOT NULL DEFAULT '{{}}'
        );
        CREATE INDEX IF NOT EXISTS artifacts_by_kind   ON artifacts(kind);
        CREATE INDEX IF NOT EXISTS artifacts_by_parent ON artifacts(parent_id);
        CREATE INDEX IF NOT EXISTS artifacts_by_source ON artifacts(source);

        CREATE TABLE IF NOT EXISTS refs (
            artifact_id TEXT NOT NULL,
            ref_id      TEXT NOT NULL,
            PRIMARY KEY (artifact_id, ref_id)
        );
        CREATE INDEX IF NOT EXISTS refs_by_ref ON refs(ref_id);

        CREATE TABLE IF NOT EXISTS chunks (
            id          INTEGER PRIMARY KEY,
            artifact_id TEXT NOT NULL,
            source      TEXT,
            art_kind    TEXT,
            title       TEXT,
            prov_tier   INTEGER NOT NULL,
            chunk_idx   INTEGER NOT NULL,
            char_start  INTEGER NOT NULL,     -- span back into artifacts.text
            char_end    INTEGER NOT NULL,
            body        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chunks_by_artifact ON chunks(artifact_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            body, title,
            content='chunks', content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
            embedding float[{embed_dim}]
        );

        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, body, title) VALUES (new.id, new.body, new.title);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, body, title)
            VALUES ('delete', old.id, old.body, old.title);
        END;

        CREATE TABLE IF NOT EXISTS graph_nodes (
            id        TEXT PRIMARY KEY,
            kind      TEXT NOT NULL,          -- "entity" | "document" | "person"
            label     TEXT NOT NULL,
            subsystem TEXT,
            source    TEXT,
            prov_tier INTEGER
        );
        CREATE INDEX IF NOT EXISTS graph_nodes_by_kind ON graph_nodes(kind);

        CREATE TABLE IF NOT EXISTS graph_edges (
            src TEXT NOT NULL,
            dst TEXT NOT NULL,
            rel TEXT NOT NULL,
            PRIMARY KEY (src, dst, rel)
        );
        CREATE INDEX IF NOT EXISTS graph_edges_by_dst ON graph_edges(dst);
        CREATE INDEX IF NOT EXISTS graph_edges_by_rel ON graph_edges(rel);

        CREATE TABLE IF NOT EXISTS impact_closures (
            artifact_id    TEXT PRIMARY KEY,
            title          TEXT,
            prov_tier      INTEGER,
            downstream_ids TEXT NOT NULL,     -- json: impacted if this changes
            upstream_ids   TEXT NOT NULL,     -- json: what this depends on
            summary        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ingest_runs (
            id          INTEGER PRIMARY KEY,
            started_at  TEXT NOT NULL,
            finished_at TEXT,
            adapter     TEXT NOT NULL,
            source_path TEXT,
            n_records   INTEGER DEFAULT 0,
            n_chunks    INTEGER DEFAULT 0,
            n_nodes     INTEGER DEFAULT 0,
            n_edges     INTEGER DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'running',
            note        TEXT
        );
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('embed_dim', ?)",
        (str(embed_dim),),
    )
    conn.commit()


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def delete_artifact(conn: sqlite3.Connection, artifact_id: str) -> None:
    """Remove an artifact and everything derived from it (snapshot replacement)."""
    conn.execute("DELETE FROM chunks WHERE artifact_id = ?", (artifact_id,))
    conn.execute("DELETE FROM refs WHERE artifact_id = ?", (artifact_id,))
    conn.execute("DELETE FROM graph_edges WHERE src = ? OR dst = ?", (artifact_id, artifact_id))
    conn.execute("DELETE FROM impact_closures WHERE artifact_id = ?", (artifact_id,))
    conn.execute("DELETE FROM graph_nodes WHERE id = ?", (artifact_id,))
    conn.execute("DELETE FROM artifacts WHERE id = ?", (artifact_id,))
