import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import type { CorpusStatsResponse, IngestAction, IngestJob, IngestStatus } from "@/api/types";
import { formatDate, formatInt, formatLatency } from "@/lib/format";

const ACTIONS: { action: IngestAction; label: string; hint: string; tone: "accent" | "danger" }[] = [
  { action: "scan", label: "Scan & update", hint: "Re-read the sources; add, update, remove changed records.", tone: "accent" },
  { action: "reingest", label: "Re-ingest", hint: "Rebuild the whole store from the configured sources.", tone: "accent" },
  { action: "clear", label: "Clear corpus", hint: "Wipe the corpus store (telemetry is kept).", tone: "danger" },
];

export function IngestionPage() {
  const [stats, setStats] = useState<CorpusStatsResponse | null>(null);
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.getCorpusStats().then(setStats).catch(() => {});
    api.getIngestJobs().then((r) => setJobs(r.jobs)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api.getIngestStatus().then(setStatus).catch(() => {});
  }, [refresh]);

  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api
        .getIngestStatus()
        .then((s) => {
          setStatus(s);
          if (!s.running) refresh(); // job finished → pull fresh stats + history
        })
        .catch(() => {});
    }, 600);
    return () => clearInterval(timer);
  }, [running, refresh]);

  async function start(action: IngestAction, confirm?: string) {
    setError(null);
    try {
      setStatus(await api.startIngest({ action, confirm }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the job.");
    }
  }

  return (
    <div className="space-y-6" data-testid="ingestion-view">
      <div>
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink">Ingestion</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Manage the corpus store — scan for changes, rebuild, or clear. The rest of the app keeps
          answering from the current store while a job runs.
        </p>
      </div>

      <CorpusSummary stats={stats} />

      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Actions</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {ACTIONS.map((a) => (
            <button
              key={a.action}
              type="button"
              disabled={running}
              data-testid={`ingest-${a.action}`}
              onClick={() => (a.action === "clear" ? setConfirmOpen(true) : start(a.action))}
              className={`flex flex-col items-start gap-1 rounded-card border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                a.tone === "danger"
                  ? "border-confidence-low/30 hover:border-confidence-low/60 hover:bg-confidence-low/5"
                  : "border-border hover:border-accent/50 hover:bg-accent-soft/40"
              }`}
            >
              <span
                className={`text-sm font-semibold ${a.tone === "danger" ? "text-confidence-low" : "text-ink"}`}
              >
                {a.label}
              </span>
              <span className="text-[12px] leading-snug text-ink-muted">{a.hint}</span>
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-sm text-confidence-low" data-testid="ingest-error">{error}</p>}
        {running && <ProgressPanel status={status!} />}
      </div>

      <HistoryTable jobs={jobs} />

      {confirmOpen && (
        <ClearConfirmModal
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void start("clear", "CLEAR");
          }}
        />
      )}
    </div>
  );
}

function CorpusSummary({ stats }: { stats: CorpusStatsResponse | null }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="corpus-summary-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-card border border-border bg-canvas-sunken" />
        ))}
      </div>
    );
  }
  const docs = stats.by_kind.document ?? 0;
  const entities = stats.by_kind.entity ?? 0;
  return (
    <div className="space-y-3" data-testid="corpus-summary">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard label="Documents" value={formatInt(docs)} />
        <SummaryCard label="Entities" value={formatInt(entities)} />
        <SummaryCard label="Chunks" value={formatInt(stats.totals.chunks)} />
        <SummaryCard label="Graph edges" value={formatInt(stats.graph.edges)} />
      </div>
      <p className="text-[12px] text-ink-faint">
        Embedder: <span className="font-mono text-ink-muted">{stats.embedder}</span>
        {stats.embed_dim ? <span className="font-mono text-ink-muted"> · dim {stats.embed_dim}</span> : null} · last
        ingest {formatDate(stats.snapshot_at)}
      </p>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="summary-card">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 font-display text-[28px] font-medium leading-none text-ink">{value}</div>
    </div>
  );
}

function ProgressPanel({ status }: { status: IngestStatus }) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-card border border-accent/30 bg-accent-soft/40 px-3 py-2.5" data-testid="ingest-progress">
      <Spinner />
      <div className="text-sm text-ink">
        <span className="font-semibold capitalize">{status.action}</span>{" "}
        <span className="text-ink-muted">— {status.stage}…</span>
      </div>
    </div>
  );
}

function HistoryTable({ jobs }: { jobs: IngestJob[] }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="ingest-history">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Ingest history</h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-ink-faint">No ingest runs yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-3 font-semibold">When</th>
                <th className="py-1.5 pr-3 font-semibold">Action</th>
                <th className="py-1.5 pr-3 font-semibold">Records</th>
                <th className="py-1.5 pr-3 font-semibold">Chunks</th>
                <th className="py-1.5 pr-3 font-semibold">Δ (add/upd/rem)</th>
                <th className="py-1.5 pr-3 font-semibold">Duration</th>
                <th className="py-1.5 pr-3 font-semibold">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/60" data-testid="ingest-history-row">
                  <td className="py-2 pr-3 text-ink-faint">{formatDate(j.finished_at ?? j.started_at)}</td>
                  <td className="py-2 pr-3 capitalize text-ink">{j.action}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{j.n_records ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono text-[12px]">{j.n_chunks ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted">{diffLabel(j)}</td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted">
                    {j.duration_ms == null ? "—" : formatLatency(j.duration_ms)}
                  </td>
                  <td className="py-2 pr-3">
                    {j.status === "ok" ? (
                      <span className="rounded-full border border-tier-formal/30 bg-tier-formal-soft px-2 py-0.5 text-[11px] font-medium text-tier-formal">
                        ok
                      </span>
                    ) : (
                      <span
                        className="rounded-full border border-confidence-low/30 bg-confidence-low/10 px-2 py-0.5 text-[11px] font-medium text-confidence-low"
                        title={j.error ?? ""}
                      >
                        error
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function diffLabel(j: IngestJob): string {
  if (j.n_added == null && j.n_updated == null && j.n_removed == null) return "—";
  return `${j.n_added ?? 0} / ${j.n_updated ?? 0} / ${j.n_removed ?? 0}`;
}

function ClearConfirmModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim() === "CLEAR";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onCancel} aria-hidden />
      <div
        className="relative w-full max-w-md rounded-card border border-border bg-canvas-raised p-5 shadow-popover"
        data-testid="clear-confirm-modal"
      >
        <h3 className="font-display text-lg font-medium text-ink">Clear the corpus?</h3>
        <p className="mt-1.5 text-sm text-ink-muted">
          This wipes every record from the corpus store. Telemetry and ingest history are kept. Type
          <span className="mx-1 rounded bg-canvas-sunken px-1 font-mono text-ink">CLEAR</span>
          to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="clear-confirm-input"
          placeholder="CLEAR"
          className="mt-3 w-full rounded-md border border-border bg-canvas px-3 py-2 font-mono text-sm text-ink focus:border-confidence-low/60 focus:outline-none"
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!armed}
            data-testid="clear-confirm-submit"
            className="rounded-md bg-confidence-low px-3 py-1.5 text-sm font-semibold text-canvas-raised transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear corpus
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-accent" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
