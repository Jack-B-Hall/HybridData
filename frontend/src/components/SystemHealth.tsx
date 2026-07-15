import { useEffect, useState } from "react";
import { api } from "@/api";
import type { TelemetryHealth } from "@/api/types";
import { formatInt, formatLatency, formatPercent } from "@/lib/format";

/**
 * "System health" — request telemetry surfaced in the Data Explorer: ask volume,
 * answer-vs-refusal rate, latency percentiles, thumbs ratio, and a recent-questions
 * table. Fed by GET /api/telemetry/health.
 */
export function SystemHealth() {
  const [health, setHealth] = useState<TelemetryHealth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getTelemetryHealth(25)
      .then((h) => !cancelled && setHealth(h))
      .catch(() => !cancelled && setHealth(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="system-health-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-card border border-border bg-canvas-sunken" />
        ))}
      </div>
    );
  }

  if (!health || health.totals.asks === 0) {
    return (
      <div
        className="rounded-card border border-dashed border-border-strong bg-canvas-sunken/60 p-8 text-center"
        data-testid="system-health-empty"
      >
        <p className="text-sm text-ink-muted">
          No questions logged yet. Ask something in the Interface and its telemetry will appear here.
        </p>
      </div>
    );
  }

  const { totals, latency, feedback, answer_rate, per_day, recent } = health;
  const totalVotes = feedback.up + feedback.down;

  return (
    <div className="space-y-6" data-testid="system-health">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <HealthCard label="Questions asked" value={formatInt(totals.asks)}
          sub={`${formatInt(totals.answered)} answered · ${formatInt(totals.refused)} declined`} />
        <HealthCard label="Answer rate" value={formatPercent(answer_rate)}
          sub={totals.errors + totals.abandoned > 0
            ? `${formatInt(totals.errors)} errors · ${formatInt(totals.abandoned)} abandoned`
            : "no errors or abandons"} />
        <HealthCard label="Latency p50 / p95" value={`${formatLatency(latency.p50_ms)} / ${formatLatency(latency.p95_ms)}`}
          sub="answered requests" />
        <HealthCard
          label="Feedback"
          value={totalVotes ? `${formatPercent(feedback.ratio)} 👍` : "—"}
          sub={`${formatInt(feedback.up)} up · ${formatInt(feedback.down)} down`}
        />
      </div>

      {per_day.length > 0 && (
        <Panel title="Questions per day">
          <DayBars data={per_day} />
        </Panel>
      )}

      <Panel title="Recent questions" testId="recent-questions">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 pr-3 font-semibold">Question</th>
                <th className="py-1.5 pr-3 font-semibold">Verdict</th>
                <th className="py-1.5 pr-3 font-semibold">Latency</th>
                <th className="py-1.5 pr-3 font-semibold">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id} className="border-b border-border/60" data-testid="recent-question-row">
                  <td className="max-w-[420px] truncate py-2 pr-3 text-ink" title={row.question}>
                    {row.question}
                  </td>
                  <td className="py-2 pr-3">
                    <VerdictBadge status={row.status} answered={row.answered} verdict={row.verdict} />
                  </td>
                  <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted">
                    {row.latency_ms == null ? "—" : formatLatency(row.latency_ms)}
                  </td>
                  <td className="py-2 pr-3">
                    {row.feedback === "up" ? (
                      <span className="text-tier-formal" title="Thumbs up">👍</span>
                    ) : row.feedback === "down" ? (
                      <span className="text-confidence-low" title="Thumbs down">👎</span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function HealthCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="health-card">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 font-display text-[24px] font-medium leading-tight text-ink">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid={testId}>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </div>
  );
}

function DayBars({ data }: { data: { day: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-2" style={{ height: 96 }}>
      {data.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d.day}: ${d.count}`}>
          <span className="font-mono text-[10px] text-ink-faint">{d.count}</span>
          <div
            className="w-full rounded-t bg-accent/70"
            style={{ height: `${Math.max(4, (d.count / max) * 70)}px` }}
          />
          <span className="font-mono text-[9px] text-ink-faint">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function VerdictBadge({
  status,
  answered,
  verdict,
}: {
  status: "ok" | "error" | "abandoned";
  answered: boolean;
  verdict: string | null;
}) {
  const meta =
    status === "error"
      ? { label: "error", cls: "border-confidence-low/30 bg-confidence-low/10 text-confidence-low" }
      : status === "abandoned"
        ? { label: "abandoned", cls: "border-tier-unverified/30 bg-tier-unverified-soft text-tier-unverified" }
        : answered
          ? { label: verdict ?? "answered", cls: "border-tier-formal/30 bg-tier-formal-soft text-tier-formal" }
          : { label: "declined", cls: "border-border bg-canvas-sunken text-ink-muted" };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${meta.cls}`}>
      {meta.label}
    </span>
  );
}
