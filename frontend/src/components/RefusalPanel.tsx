import type { AskResult } from "@/api/types";
import { SourcesPanel } from "./SourcesPanel";
import { formatPercent } from "@/lib/format";

export interface RefusalPanelProps {
  result: AskResult;
}

/**
 * The refusal state is a feature, not an error: the gate declined to
 * answer because retrieval evidence didn't clear the bar. This is
 * presented distinctly from a normal answer — calm, informative, and
 * still useful (it shows the closest matches it did find).
 */
export function RefusalPanel({ result }: RefusalPanelProps) {
  return (
    <div className="animate-fade-in space-y-6" data-testid="refusal-panel">
      <div className="rounded-card border border-dashed border-border-strong bg-canvas-sunken p-6">
        <div className="flex items-start gap-4">
          <div
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-canvas-raised text-lg"
          >
            🧭
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-medium text-ink">Not in the corpus</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-muted">{result.answer}</p>
            <p className="mt-3 text-xs text-ink-faint">
              Term coverage was {formatPercent(result.signals.term_coverage)} against the retrieved
              evidence — below the threshold to answer with confidence. Declining to answer beats
              inventing a plausible-sounding one.
            </p>
          </div>
        </div>
      </div>

      <SourcesPanel
        sources={result.sources}
        title="Closest matches"
        emptyLabel="Retrieval found nothing related to this question."
      />
    </div>
  );
}
