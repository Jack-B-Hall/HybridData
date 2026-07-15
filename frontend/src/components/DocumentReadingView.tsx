import { useEffect, useRef } from "react";
import type { DocumentDetail } from "@/api/types";
import { localHighlightRange, type HighlightRange } from "@/lib/highlight";

export interface DocumentReadingViewProps {
  document: DocumentDetail;
  highlight?: HighlightRange;
}

/**
 * A narrow, scrollable reading view of a document's full text with the cited
 * passage highlighted and scrolled into view. Used inside the source slide-over;
 * it owns its own scroll container so the drawer can stay a fixed shell.
 */
export function DocumentReadingView({ document, highlight }: DocumentReadingViewProps) {
  const markRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Center the highlighted passage within the drawer's reading pane.
    if (markRef.current) {
      markRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [document.id, highlight?.start, highlight?.end]);

  const sections = document.sections;
  const hasText = document.text.length > 0 || sections.length > 0;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {!hasText && (
        <p className="rounded-card border border-dashed border-border-strong bg-canvas-sunken p-4 text-sm text-ink-faint">
          Full document text isn&apos;t available for this artifact in the current data set. Use
          <span className="font-medium"> Open full document </span> to see everything the record holds.
        </p>
      )}
      <div className="space-y-5" data-testid="drawer-reading-view">
        {sections.map((section) => {
          const local = localHighlightRange(section.char_start, section.body.length, highlight);
          return (
            <section
              key={section.chunk_idx}
              className="whitespace-pre-wrap text-[13.5px] leading-[1.7] text-ink"
            >
              {local ? (
                <>
                  {section.body.slice(0, local.start)}
                  <mark
                    ref={markRef}
                    data-testid="drawer-highlight"
                    className="rounded bg-accent-soft px-0.5 text-ink ring-1 ring-inset ring-accent/40"
                  >
                    {section.body.slice(local.start, local.end)}
                  </mark>
                  {section.body.slice(local.end)}
                </>
              ) : (
                section.body
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
