import { useState } from "react";
import type { AskResult } from "@/api/types";
import { confidenceMeta } from "@/lib/confidence";
import { formatPercent, formatScore } from "@/lib/format";

export interface ConfidenceIndicatorProps {
  result: AskResult;
}

/**
 * Prominent verdict pill that expands (hover or click) to reveal the raw
 * gate signals driving it. Confidence here is retrieval math, not model
 * self-assessment — the disclosure says so explicitly.
 */
export function ConfidenceIndicator({ result }: ConfidenceIndicatorProps) {
  const [open, setOpen] = useState(false);
  const meta = confidenceMeta(result.confidence);
  const { signals } = result;

  return (
    <div
      className="group relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      data-testid="confidence-indicator"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors"
        style={{
          borderColor: `color-mix(in srgb, ${meta.colorVar} 35%, transparent)`,
          backgroundColor: `color-mix(in srgb, ${meta.colorVar} 12%, transparent)`,
          color: meta.colorVar,
        }}
      >
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: meta.colorVar }} />
        {meta.label}
        <span className="text-ink-faint transition-transform group-hover:translate-y-0.5" aria-hidden>
          {open ? "▲" : "▾"}
        </span>
      </button>

      {open && (
        <div
          data-testid="confidence-detail"
          className="absolute left-0 top-full z-40 mt-2 w-80 animate-pop-in rounded-card border border-border bg-canvas-overlay p-4 shadow-popover"
        >
          <p className="mb-3 text-xs leading-relaxed text-ink-muted">
            Confidence is <strong className="text-ink">retrieval math</strong>, not model
            self-assessment — it reflects how well the retrieved evidence covers the question, not
            the model&apos;s own certainty.
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <SignalRow label="Term coverage" value={formatPercent(signals.term_coverage)} />
            <SignalRow label="ID anchor" value={signals.id_anchor ? "Yes" : "No"} />
            <SignalRow label="Top score" value={formatScore(signals.top_score)} />
            <SignalRow label="Strong hits" value={`${signals.n_strong}`} />
            <SignalRow label="Chunks used" value={`${signals.n_chunks}`} />
            <SignalRow label="Query terms" value={`${signals.n_terms}`} />
          </dl>
        </div>
      )}
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="font-mono text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}
