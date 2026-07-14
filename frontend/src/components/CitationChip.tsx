import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Citation } from "@/api/types";
import { Popover } from "./Popover";
import { TierBadge } from "./TierBadge";
import { documentHighlightPath } from "@/lib/paths";

export interface CitationChipProps {
  citation: Citation;
}

/** An inline `[n]` marker rendered as an interactive citation chip. */
export function CitationChip({ citation }: CitationChipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Citation ${citation.marker}: ${citation.title}`}
        data-testid="citation-chip"
        data-marker={citation.marker}
        className={`mx-0.5 inline-flex h-[19px] min-w-[19px] translate-y-[-1px] items-center justify-center rounded-[5px] border px-1 font-mono text-[11px] font-medium leading-none transition-colors ${
          open
            ? "border-accent bg-accent text-canvas-raised"
            : "border-accent/30 bg-accent-soft text-accent-ink hover:border-accent/60 hover:bg-accent/15"
        }`}
      >
        {citation.marker}
      </button>
      {open && triggerRef.current && (
        <Popover anchorEl={triggerRef.current} onClose={() => setOpen(false)}>
          <div className="flex min-h-0 flex-1 flex-col" data-testid="citation-popover">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-ink-faint">{citation.artifact_id}</div>
                <div className="truncate font-medium text-ink" title={citation.title}>
                  {citation.title}
                </div>
              </div>
              <TierBadge tier={citation.tier_label} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-ink-muted">
              <p className="whitespace-pre-line">{citation.passage}</p>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-canvas-sunken px-4 py-2.5">
              <span className="text-xs text-ink-faint">{citation.source}</span>
              <button
                type="button"
                data-testid="citation-open-document"
                onClick={() =>
                  navigate(
                    documentHighlightPath(citation.artifact_id, {
                      chunk_idx: citation.chunk_idx,
                      char_start: citation.char_start,
                      char_end: citation.char_end,
                    }),
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-canvas-raised transition-colors hover:bg-accent-strong"
              >
                Open full document
                <span aria-hidden>→</span>
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
