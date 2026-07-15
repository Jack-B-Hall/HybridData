import { useEffect, useState } from "react";
import { api } from "@/api";
import type { CorpusStatsResponse, IngestRun } from "@/api/types";
import { BarList } from "@/components/BarList";
import { SystemHealth } from "@/components/SystemHealth";
import { formatDate, formatInt } from "@/lib/format";

export function ExplorerAnalyticsTab() {
  const [stats, setStats] = useState<CorpusStatsResponse | null>(null);
  const [runs, setRuns] = useState<IngestRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getCorpusStats(), api.getIngestHistory()])
      .then(([s, h]) => {
        setStats(s);
        setRuns(h.runs);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8" data-testid="analytics-view">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-ink">System health</h2>
        <SystemHealth />
      </section>

      <section className="space-y-6">
        <h2 className="text-sm font-semibold text-ink">Corpus</h2>
        {loading || !stats ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-card border border-border bg-canvas-sunken" />
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Artifacts" value={stats.totals.artifacts} />
        <StatCard label="Chunks" value={stats.totals.chunks} />
        <StatCard label="References" value={stats.totals.refs} />
        <StatCard label="Graph edges" value={stats.graph.edges} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="By kind">
          <BarList data={stats.by_kind} color="var(--color-accent)" />
        </Panel>
        <Panel title="By provenance tier">
          <TierBars byTier={stats.by_tier} />
        </Panel>
        <Panel title="By source">
          <BarList data={stats.by_source} color="var(--color-tier-informal)" />
        </Panel>
        <Panel title="By subsystem">
          <BarList data={stats.by_subsystem} color="var(--color-tier-formal)" limit={10} />
        </Panel>
      </div>

      <Panel title={`Graph relationship types (${Object.keys(stats.graph.edges_by_rel).length})`}>
        <BarList data={stats.graph.edges_by_rel} color="var(--color-accent)" limit={12} />
      </Panel>

      <Panel title="Ingestion history" testId="ingest-history">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-3 font-semibold">Run</th>
                <th className="py-1.5 pr-3 font-semibold">Adapter</th>
                <th className="py-1.5 pr-3 font-semibold">Records</th>
                <th className="py-1.5 pr-3 font-semibold">Chunks</th>
                <th className="py-1.5 pr-3 font-semibold">Nodes</th>
                <th className="py-1.5 pr-3 font-semibold">Edges</th>
                <th className="py-1.5 pr-3 font-semibold">Status</th>
                <th className="py-1.5 pr-3 font-semibold">Finished</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-border/60">
                  <td className="py-2 pr-3 font-mono text-[12px] text-ink-faint">#{run.id}</td>
                  <td className="py-2 pr-3 text-ink-muted">{run.adapter}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{formatInt(run.n_records)}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{formatInt(run.n_chunks)}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{formatInt(run.n_nodes)}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{formatInt(run.n_edges)}</td>
                  <td className="py-2 pr-3">
                    <span className="rounded-full border border-tier-formal/30 bg-tier-formal-soft px-2 py-0.5 text-[11px] font-medium text-tier-formal">
                      {run.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-ink-faint">{formatDate(run.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-ink-faint">
          Snapshot taken {formatDate(stats.snapshot_at)} · embedder: {stats.embedder}
        </p>
      </Panel>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="stat-card">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 font-display text-[28px] font-medium leading-none text-ink">{formatInt(value)}</div>
    </div>
  );
}

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid={testId}>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h2>
      {children}
    </div>
  );
}

function TierBars({ byTier }: { byTier: Record<string, number> }) {
  const colorFor = (label: string) =>
    label === "formal"
      ? "var(--color-tier-formal)"
      : label === "unverified"
        ? "var(--color-tier-unverified)"
        : "var(--color-tier-informal)";
  const max = Math.max(1, ...Object.values(byTier));
  return (
    <ul className="space-y-2">
      {Object.entries(byTier).map(([label, value]) => (
        <li key={label} className="text-sm">
          <div className="mb-1 flex items-center justify-between gap-2 capitalize">
            <span className="text-ink-muted">{label}</span>
            <span className="font-mono text-[11px] text-ink-faint">{formatInt(value)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas-sunken">
            <div
              className="h-full rounded-full"
              style={{ width: `${(value / max) * 100}%`, backgroundColor: colorFor(label) }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
