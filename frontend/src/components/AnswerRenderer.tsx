import { Children } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { parseInlineCitations } from "@/lib/citations";
import type { Citation } from "@/api/types";
import { CitationChip } from "./CitationChip";

export interface AnswerRendererProps {
  answer: string;
  citations: Citation[];
  /**
   * While an answer is still streaming the citation list has not been resolved
   * yet, so `[n]` markers render as inert chip-styled spans instead of
   * interactive chips that would open an empty source drawer.
   */
  streaming?: boolean;
}

/**
 * Renders answer text as GitHub-flavoured markdown (paragraphs, lists, tables),
 * turning inline `[n]` markers into citation chips wherever they appear,
 * including inside list items and table cells. Raw HTML in the model output is
 * never parsed as HTML (react-markdown's safe default; no rehype-raw), so
 * anything like `<script>` renders as inert text.
 */
export function AnswerRenderer({ answer, citations, streaming = false }: AnswerRendererProps) {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));

  const renderMarker = (marker: number, key: React.Key): ReactNode => {
    if (streaming) {
      return (
        <span
          key={key}
          aria-hidden
          className="mx-0.5 inline-flex h-[19px] min-w-[19px] translate-y-[-1px] items-center justify-center rounded-[5px] border border-border bg-accent-soft px-1 font-mono text-[11px] font-medium leading-none text-accent-ink"
        >
          {marker}
        </span>
      );
    }
    return (
      <CitationChip
        key={key}
        citation={
          byMarker.get(marker) ?? {
            marker,
            artifact_id: "unknown",
            title: "Unknown source",
            source: "",
            tier_label: "informal",
            chunk_idx: 0,
            char_start: 0,
            char_end: 0,
            passage: "No passage available for this citation.",
            grounded: false,
          }
        }
      />
    );
  };

  /**
   * Replace `[n]` markers inside the string children of a rendered markdown
   * element. Only plain strings are transformed; nested elements are handled by
   * their own component overrides, so markers survive arbitrary nesting
   * (bold inside a list item inside a table cell, ...).
   */
  const chipify = (children: ReactNode): ReactNode =>
    Children.map(children, (child, i) => {
      if (typeof child === "string") {
        return parseInlineCitations(child).map((part, j) =>
          part.type === "text" ? (
            <span key={`${i}-${j}`}>{part.value}</span>
          ) : (
            renderMarker(part.marker, `${i}-${j}`)
          ),
        );
      }
      return child;
    });

  const components: Components = {
    p: ({ node: _n, children, ...props }) => (
      <p className="text-[15px] leading-relaxed text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    ul: ({ node: _n, children, ...props }) => (
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink marker:text-ink-faint" {...props}>
        {children}
      </ul>
    ),
    ol: ({ node: _n, children, ...props }) => (
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink marker:text-ink-faint" {...props}>
        {children}
      </ol>
    ),
    li: ({ node: _n, children, ...props }) => (
      <li className="pl-0.5" {...props}>
        {chipify(children)}
      </li>
    ),
    strong: ({ node: _n, children, ...props }) => (
      <strong className="font-semibold text-ink" {...props}>
        {chipify(children)}
      </strong>
    ),
    em: ({ node: _n, children, ...props }) => (
      <em {...props}>{chipify(children)}</em>
    ),
    del: ({ node: _n, children, ...props }) => (
      <del {...props}>{chipify(children)}</del>
    ),
    h1: ({ node: _n, children, ...props }) => (
      <p className="font-display text-lg font-medium text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    h2: ({ node: _n, children, ...props }) => (
      <p className="font-display text-lg font-medium text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    h3: ({ node: _n, children, ...props }) => (
      <p className="text-[15px] font-semibold text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    h4: ({ node: _n, children, ...props }) => (
      <p className="text-[15px] font-semibold text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    h5: ({ node: _n, children, ...props }) => (
      <p className="text-[15px] font-semibold text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    h6: ({ node: _n, children, ...props }) => (
      <p className="text-[15px] font-semibold text-ink" {...props}>
        {chipify(children)}
      </p>
    ),
    blockquote: ({ node: _n, children, ...props }) => (
      <blockquote className="border-l-2 border-border-strong pl-3 text-ink-muted" {...props}>
        {children}
      </blockquote>
    ),
    hr: ({ node: _n, ...props }) => <hr className="border-t border-border" {...props} />,
    a: ({ node: _n, children, ...props }) => (
      // Model output is untrusted: no target=_blank, and rel guards any click.
      <a className="text-accent underline underline-offset-2" rel="nofollow noopener" {...props}>
        {chipify(children)}
      </a>
    ),
    code: ({ node: _n, children, ...props }) => (
      <code className="rounded bg-canvas-sunken px-1 py-0.5 font-mono text-[13px] text-ink" {...props}>
        {children}
      </code>
    ),
    pre: ({ node: _n, children, ...props }) => (
      <pre className="overflow-x-auto rounded-card border border-border bg-canvas-sunken p-3 font-mono text-[13px] leading-relaxed text-ink" {...props}>
        {children}
      </pre>
    ),
    // Wide tables scroll inside their own container so the answer column never
    // stretches the page. Styling mirrors the Data Explorer table.
    table: ({ node: _n, children, ...props }) => (
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full border-collapse text-sm" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ node: _n, children, ...props }) => (
      <thead className="bg-canvas-sunken" {...props}>
        {children}
      </thead>
    ),
    tr: ({ node: _n, children, ...props }) => (
      <tr className="border-b border-border last:border-b-0" {...props}>
        {children}
      </tr>
    ),
    th: ({ node: _n, children, ...props }) => (
      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-faint" {...props}>
        {chipify(children)}
      </th>
    ),
    td: ({ node: _n, children, ...props }) => (
      <td className="px-3 py-2 align-top text-[14px] leading-relaxed text-ink" {...props}>
        {chipify(children)}
      </td>
    ),
  };

  return (
    <div className="space-y-3" data-testid="answer-body">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {answer}
      </Markdown>
    </div>
  );
}
