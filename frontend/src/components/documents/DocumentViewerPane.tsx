import { useEffect, useMemo, useRef } from "react";
import type { DocumentDetail } from "@/api/types";
import { TierBadge } from "@/components/TierBadge";
import { RefChip } from "./RefChip";
import { firstHeading, localHighlightRange, type HighlightRange } from "@/lib/highlight";
import { formatInt } from "@/lib/format";

export interface DocumentViewerPaneProps {
  document: DocumentDetail;
  highlight?: HighlightRange & { chunkIdx?: number };
}

export function DocumentViewerPane({ document, highlight }: DocumentViewerPaneProps) {
  const highlightRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // A highlight near the very start of the document sits right below the
    // title/metadata header anyway — scrolling straight to it would push
    // that context off-screen for no benefit, so just settle at the top of
    // the document instead. Only jump-scroll for passages genuinely deeper
    // in the text.
    if (highlight && highlight.start > 200) {
      highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [document.id, highlight?.start, highlight?.end]);

  const sections = document.sections;
  const hasFullText = document.text.length > 0 || sections.length > 0;

  const metadataEntries = useMemo(() => Object.entries(document.metadata ?? {}), [document.metadata]);

  return (
    <div className="grid min-h-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr),300px]">
      <div className="min-w-0 rounded-card border border-border bg-canvas-raised shadow-panel">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-2 font-mono text-[12px] text-ink-faint">
            <span>{document.id}</span>
            <span className="text-ink-faint/50">·</span>
            <span>{document.source}</span>
          </div>
          <h1 className="mt-1 font-display text-2xl font-medium leading-tight text-ink" data-testid="document-title">
            {document.title}
          </h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <TierBadge tier={document.tier_label} size="md" />
            {document.subsystem && (
              <span className="rounded-full border border-border bg-canvas-sunken px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                {document.subsystem}
              </span>
            )}
            <span className="rounded-full border border-border bg-canvas-sunken px-2 py-0.5 text-[11px] font-medium capitalize text-ink-muted">
              {document.kind}
            </span>
          </div>
        </div>

        {sections.length > 0 && (
          <nav className="flex flex-wrap gap-1.5 border-b border-border bg-canvas-sunken/60 px-5 py-2.5" aria-label="Sections">
            {sections.map((section) => {
              const label = firstHeading(section.body) ?? `Section ${section.chunk_idx + 1}`;
              return (
                <a
                  key={section.chunk_idx}
                  href={`#section-${section.chunk_idx}`}
                  className="rounded-full border border-border bg-canvas-raised px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-accent/40 hover:text-accent-ink"
                >
                  {label}
                </a>
              );
            })}
          </nav>
        )}

        <div className="space-y-6 p-5" data-testid="document-body">
          {!hasFullText && (
            <p className="rounded-card border border-dashed border-border-strong bg-canvas-sunken p-4 text-sm text-ink-faint">
              Full document text isn&apos;t available in mock mode for this artifact — only one
              complete document ships in the committed fixtures. Connect to the live backend
              (<code className="font-mono">hde serve</code>) to browse full text for every artifact.
            </p>
          )}
          {sections.map((section) => {
            const local = localHighlightRange(section.char_start, section.body.length, highlight);
            return (
              <section
                key={section.chunk_idx}
                id={`section-${section.chunk_idx}`}
                className="scroll-mt-20 whitespace-pre-wrap text-[14.5px] leading-[1.75] text-ink"
              >
                {local ? (
                  <>
                    {section.body.slice(0, local.start)}
                    <mark
                      ref={highlightRef}
                      data-testid="highlighted-passage"
                      className="scroll-mt-24 rounded bg-accent-soft px-0.5 text-ink ring-1 ring-inset ring-accent/40"
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

      <aside className="min-w-0 space-y-5">
        <Panel title="Metadata">
          <dl className="space-y-2 text-sm">
            <MetaRow label="Source" value={document.source} />
            <MetaRow label="Subsystem" value={document.subsystem ?? "—"} />
            <MetaRow label="Parent" value={document.parent_id ?? "—"} />
            <MetaRow label="Provenance tier" value={`${document.prov_tier}`} />
            {metadataEntries.map(([key, value]) => (
              <MetaRow key={key} label={key.replace(/_/g, " ")} value={formatMetaValue(value)} />
            ))}
          </dl>
        </Panel>

        {document.refs.length > 0 && (
          <Panel title="References" testId="refs-panel">
            <ChipRow ids={document.refs} />
          </Panel>
        )}

        {document.referenced_by.length > 0 && (
          <Panel title="Referenced by" testId="referenced-by-panel">
            <ChipRow ids={document.referenced_by} />
          </Panel>
        )}

        {(document.closure.downstream_ids.length > 0 || document.closure.upstream_ids.length > 0) && (
          <Panel title="Impact closure" testId="closure-panel">
            {document.closure.summary && (
              <p className="mb-3 text-xs leading-relaxed text-ink-muted">{document.closure.summary}</p>
            )}
            {document.closure.downstream_ids.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Downstream ({formatInt(document.closure.downstream_ids.length)})
                </div>
                <ChipRow ids={document.closure.downstream_ids} />
              </div>
            )}
            {document.closure.upstream_ids.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                  Upstream ({formatInt(document.closure.upstream_ids.length)})
                </div>
                <ChipRow ids={document.closure.upstream_ids} />
              </div>
            )}
          </Panel>
        )}
      </aside>
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

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="capitalize text-ink-faint">{label}</dt>
      <dd className="truncate text-right font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ChipRow({ ids }: { ids: string[] }) {
  return (
    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
      {ids.map((id) => (
        <RefChip key={id} id={id} />
      ))}
    </div>
  );
}

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
