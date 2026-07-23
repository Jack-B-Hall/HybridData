import type { Citation } from "@/api/types";
import { useDrawer, targetFromCitation } from "@/store/drawer";

export interface CitationChipProps {
  citation: Citation;
}

/**
 * An inline `[n]` marker rendered as an interactive citation chip. Clicking it
 * opens the source slide-over at the exact grounding passage.
 */
export function CitationChip({ citation }: CitationChipProps) {
  const { open, target } = useDrawer();
  const active = target?.artifactId === citation.artifact_id;

  return (
    <button
      type="button"
      onClick={() => open(targetFromCitation(citation))}
      aria-label={`Citation ${citation.marker}: ${citation.title}`}
      data-testid="citation-chip"
      data-marker={citation.marker}
      className={`mx-0.5 inline-flex h-[19px] min-w-[19px] translate-y-[-1px] items-center justify-center rounded-[5px] border px-1 font-mono text-[11px] font-medium leading-none transition-colors ${
        active
          ? "border-accent bg-accent text-canvas-raised"
          : "border-border bg-accent-soft text-accent-ink hover:border-accent"
      }`}
    >
      {citation.marker}
    </button>
  );
}
