import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import type { ArtifactKind, DocumentSummary } from "@/api/types";
import { TierBadge } from "@/components/TierBadge";

type SortKey = "id" | "title" | "source" | "subsystem" | "tier_label" | "kind";
type SortDir = "asc" | "desc";

export function ExplorerTableTab() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ArtifactKind | "">("");
  const [sortKey, setSortKey] = useState<SortKey>("id");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    api
      .getDocuments({ limit: 1000 })
      .then((res) => setDocuments(res.documents))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    let list = documents;
    if (kind) list = list.filter((d) => d.kind === kind);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((d) => d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q));
    }
    const sorted = [...list].sort((a, b) => {
      const av = String(a[sortKey] ?? "");
      const bv = String(b[sortKey] ?? "");
      return av.localeCompare(bv);
    });
    return sortDir === "asc" ? sorted : sorted.reverse();
  }, [documents, kind, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return (
    <div className="flex h-full min-h-[560px] flex-col rounded-card border border-border bg-canvas-raised shadow-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search id or title…"
          data-testid="table-search"
          className="min-w-[220px] flex-1 rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ArtifactKind | "")}
          data-testid="table-filter-kind"
          className="rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
        >
          <option value="">All kinds</option>
          <option value="document">Document</option>
          <option value="entity">Entity</option>
          <option value="person">Person</option>
        </select>
        <span className="text-xs text-ink-faint">{loading ? "Loading…" : `${rows.length} rows`}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm" data-testid="documents-table">
          <thead className="sticky top-0 z-10 bg-canvas-raised">
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
              <Th label="ID" sortKey="id" active={sortKey} dir={sortDir} onSort={toggleSort} />
              <Th label="Title" sortKey="title" active={sortKey} dir={sortDir} onSort={toggleSort} />
              <Th label="Kind" sortKey="kind" active={sortKey} dir={sortDir} onSort={toggleSort} />
              <Th label="Source" sortKey="source" active={sortKey} dir={sortDir} onSort={toggleSort} />
              <Th label="Subsystem" sortKey="subsystem" active={sortKey} dir={sortDir} onSort={toggleSort} />
              <Th label="Tier" sortKey="tier_label" active={sortKey} dir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((doc) => (
              <tr key={doc.id} className="border-b border-border/60 transition-colors hover:bg-canvas-sunken">
                <td className="px-3 py-2">
                  <Link
                    to={`/documents/${encodeURIComponent(doc.id)}`}
                    data-testid="table-row-link"
                    className="font-mono text-[12px] text-accent-ink hover:underline"
                  >
                    {doc.id}
                  </Link>
                </td>
                <td className="max-w-[360px] truncate px-3 py-2 text-ink" title={doc.title}>
                  {doc.title}
                </td>
                <td className="px-3 py-2 capitalize text-ink-muted">{doc.kind}</td>
                <td className="px-3 py-2 text-ink-muted">{doc.source}</td>
                <td className="px-3 py-2 text-ink-muted">{doc.subsystem ?? "—"}</td>
                <td className="px-3 py-2">
                  <TierBadge tier={doc.tier_label} />
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-ink-faint">
                  No documents match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th className="px-3 py-2 font-semibold">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 transition-colors ${isActive ? "text-accent-ink" : "hover:text-ink"}`}
      >
        {label}
        {isActive && <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}
