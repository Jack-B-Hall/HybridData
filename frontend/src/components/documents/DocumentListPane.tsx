import { Link } from "react-router-dom";
import type { ArtifactKind, DocumentSummary } from "@/api/types";
import { TierBadge } from "@/components/TierBadge";

export interface DocumentListPaneProps {
  documents: DocumentSummary[];
  count: number;
  loading: boolean;
  selectedId?: string;
  query: string;
  onQueryChange: (q: string) => void;
  kind: ArtifactKind | "";
  onKindChange: (k: ArtifactKind | "") => void;
  source: string;
  onSourceChange: (s: string) => void;
  subsystem: string;
  onSubsystemChange: (s: string) => void;
  sources: string[];
  subsystems: string[];
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  document: "Document",
  entity: "Entity",
  person: "Person",
};

export function DocumentListPane(props: DocumentListPaneProps) {
  const {
    documents,
    count,
    loading,
    selectedId,
    query,
    onQueryChange,
    kind,
    onKindChange,
    source,
    onSourceChange,
    subsystem,
    onSubsystemChange,
    sources,
    subsystems,
  } = props;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-card border border-border bg-canvas-raised shadow-panel">
      <div className="space-y-2.5 border-b border-border p-3">
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search id or title…"
          data-testid="document-search"
          className="w-full rounded-md border border-border bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <div className="flex flex-wrap gap-1.5">
          <select
            value={kind}
            onChange={(e) => onKindChange(e.target.value as ArtifactKind | "")}
            data-testid="filter-kind"
            className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
          >
            <option value="">All kinds</option>
            {(Object.keys(KIND_LABEL) as ArtifactKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
            data-testid="filter-source"
            className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={subsystem}
            onChange={(e) => onSubsystemChange(e.target.value)}
            data-testid="filter-subsystem"
            className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
          >
            <option value="">All subsystems</option>
            {subsystems.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-ink-faint">
        <span>{loading ? "Loading…" : `${count} result${count === 1 ? "" : "s"}`}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="document-list">
        {!loading && documents.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-ink-faint">No documents match these filters.</p>
        )}
        <ul className="space-y-1">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Link
                to={`/documents/${encodeURIComponent(doc.id)}`}
                data-testid="document-row"
                aria-current={doc.id === selectedId ? "page" : undefined}
                className={`block rounded-md border px-2.5 py-2 transition-colors ${
                  doc.id === selectedId
                    ? "border-accent/50 bg-accent-soft/60"
                    : "border-transparent hover:border-border hover:bg-canvas-sunken"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-ink-faint">{doc.id}</span>
                  <TierBadge tier={doc.tier_label} />
                </div>
                <div className="mt-0.5 truncate text-sm text-ink" title={doc.title}>
                  {doc.title}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-faint">
                  {doc.source}
                  {doc.subsystem ? ` · ${doc.subsystem}` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
