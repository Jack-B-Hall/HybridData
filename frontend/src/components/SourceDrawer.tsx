import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import type { DocumentDetail } from "@/api/types";
import { useDrawer, type DrawerTarget } from "@/store/drawer";
import { TierBadge } from "./TierBadge";
import { DocumentReadingView } from "./DocumentReadingView";
import { documentHighlightPath } from "@/lib/paths";

const EXIT_MS = 220;

/**
 * A right-hand slide-over that opens on a cited source. It shows the grounding
 * passage immediately, loads the full document into a narrow reading view
 * scrolled to the highlight, and hands off to the Documents tab on request.
 * Rendered once at app level (see App.tsx) so it overlays every route.
 */
export function SourceDrawer() {
  const { target, close } = useDrawer();
  const navigate = useNavigate();

  // `active` keeps the last target alive through the slide-out animation.
  const [active, setActive] = useState<DrawerTarget | null>(null);
  const [visible, setVisible] = useState(false);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (target) {
      setActive(target);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const timer = setTimeout(() => setActive(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [target]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setDoc(null);
    setLoading(true);
    api
      .getDocument(active.artifactId)
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch(() => {
        if (!cancelled) setDoc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.artifactId]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, close]);

  if (!active) return null;

  const highlight = { start: active.charStart, end: active.charEnd };

  function openFullDocument() {
    if (!active) return;
    navigate(
      documentHighlightPath(active.artifactId, {
        chunk_idx: active.chunkIdx,
        char_start: active.charStart,
        char_end: active.charEnd,
      }),
    );
    close();
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={`Source ${active.artifactId}`}>
      <div
        aria-hidden
        onClick={close}
        className={`absolute inset-0 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />
      <aside
        data-testid="source-drawer"
        className={`absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col border-l border-border bg-canvas-raised shadow-popover transition-transform duration-200 ease-out ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
              <span>{active.artifactId}</span>
              <span className="text-ink-faint/50">·</span>
              <span>{active.source}</span>
            </div>
            <h2 className="mt-0.5 truncate font-display text-lg font-medium text-ink" title={active.title}>
              {active.title}
            </h2>
            <div className="mt-1.5">
              <TierBadge tier={active.tierLabel} />
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            data-testid="drawer-close"
            aria-label="Close source"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="shrink-0 border-b border-border bg-canvas-sunken/60 px-5 py-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Cited passage
          </div>
          <p
            data-testid="drawer-passage"
            className="max-h-32 overflow-y-auto whitespace-pre-line rounded-md border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[13px] leading-relaxed text-ink"
          >
            {active.passage || "No passage text available."}
          </p>
        </div>

        {loading && !doc ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-5 py-4" aria-busy="true">
            <div className="h-3 w-24 animate-pulse rounded bg-canvas-sunken" />
            <div className="h-3 w-full animate-pulse rounded bg-canvas-sunken" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-canvas-sunken" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-canvas-sunken" />
          </div>
        ) : doc ? (
          <DocumentReadingView document={doc} highlight={highlight} />
        ) : (
          <div className="min-h-0 flex-1 px-5 py-4 text-sm text-ink-faint">
            Couldn&apos;t load the full document. The cited passage above is still shown.
          </div>
        )}

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-canvas-sunken px-5 py-3">
          <span className="text-xs text-ink-faint">Reading view · scroll for context</span>
          <button
            type="button"
            onClick={openFullDocument}
            data-testid="drawer-open-document"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-canvas-raised transition-colors hover:bg-accent-strong"
          >
            Open full document
            <span aria-hidden>↗</span>
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
