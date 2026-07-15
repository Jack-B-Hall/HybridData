import type { Source } from "@/api/types";
import { TierBadge } from "./TierBadge";
import { formatScore } from "@/lib/format";
import { useDrawer, targetFromSource } from "@/store/drawer";

const LEG_LABEL: Record<string, string> = {
  fts: "Full-text",
  vector: "Vector",
  graph: "Graph",
  exact: "Exact ID",
};

export interface SourcesPanelProps {
  sources: Source[];
  title: string;
  emptyLabel?: string;
}

export function SourcesPanel({ sources, title, emptyLabel = "No sources retrieved." }: SourcesPanelProps) {
  const { open } = useDrawer();
  return (
    <div data-testid="sources-panel">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
        <span className="ml-1.5 font-mono normal-case text-ink-faint">({sources.length})</span>
      </h2>
      {sources.length === 0 ? (
        <p className="text-sm text-ink-faint">{emptyLabel}</p>
      ) : (
        <ol className="space-y-2">
          {sources.map((source) => (
            <li key={`${source.artifact_id}-${source.chunk_idx}`}>
              <button
                type="button"
                onClick={() => open(targetFromSource(source))}
                data-testid="source-card"
                className="group block w-full rounded-card border border-border bg-canvas-raised p-3 text-left shadow-panel transition-colors hover:border-accent/40 hover:bg-accent-soft/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                      {source.artifact_id}
                      <span className="text-ink-faint/50">·</span>
                      {source.source}
                    </div>
                    <div className="mt-0.5 truncate text-sm font-medium text-ink group-hover:text-accent-ink">
                      {source.title}
                    </div>
                  </div>
                  <TierBadge tier={source.tier_label} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1">
                    {source.legs.map((leg) => (
                      <span
                        key={leg}
                        className="rounded border border-border bg-canvas-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-muted"
                      >
                        {LEG_LABEL[leg] ?? leg}
                      </span>
                    ))}
                  </div>
                  <span className="font-mono text-[11px] text-ink-faint">{formatScore(source.score)}</span>
                </div>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
