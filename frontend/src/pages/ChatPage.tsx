import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnswerRenderer } from "@/components/AnswerRenderer";
import { ConfidenceIndicator } from "@/components/ConfidenceIndicator";
import { SourcesPanel } from "@/components/SourcesPanel";
import { RefusalPanel } from "@/components/RefusalPanel";
import { GraphPathsList } from "@/components/GraphPathsList";
import { FeedbackControl } from "@/components/FeedbackControl";
import { formatLatency, modelLabel } from "@/lib/format";
import { useChat, type Turn } from "@/store/chat";
import { useCorpusMeta } from "@/store/corpusMeta";
import type { CorpusStarterQuestion } from "@/api/types";

export function ChatPage() {
  const { turns, draft, setDraft, submit, removeTurn, clearAll, scrollTopRef } = useChat();
  const corpus = useCorpusMeta();
  const listRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(turns.length);

  // Restore the scroll offset saved when we last left this tab.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = scrollTopRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On a new question, scroll to the bottom to reveal it.
  useEffect(() => {
    if (turns.length > prevCount.current && listRef.current) {
      requestAnimationFrame(() =>
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }),
      );
    }
    prevCount.current = turns.length;
  }, [turns.length]);

  return (
    <div className="relative flex min-h-[calc(100vh-8.5rem)] flex-col">
      {turns.length > 0 && (
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium text-ink-faint">
            {turns.length} {turns.length === 1 ? "question" : "questions"}
          </span>
          <ClearAllButton onConfirm={clearAll} />
        </div>
      )}

      <div
        ref={listRef}
        onScroll={(e) => (scrollTopRef.current = e.currentTarget.scrollTop)}
        className="flex-1 space-y-8 overflow-y-auto pb-28"
      >
        {turns.length === 0 ? (
          <EmptyState onPick={submit} starters={corpus.starter_questions} />
        ) : (
          turns.map((turn) => <TurnBlock key={turn.id} turn={turn} onRemove={() => removeTurn(turn.id)} />)
        )}
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-canvas to-transparent"
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="sticky bottom-4 mt-4"
      >
        <div className="flex items-end gap-2 rounded-card border border-border-strong bg-canvas-raised p-2 shadow-popover focus-within:border-accent/60">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={1}
            placeholder={corpus.placeholder}
            data-testid="ask-input"
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="submit"
            data-testid="ask-submit"
            disabled={!draft.trim()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-semibold text-canvas-raised transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-ink-faint"
          >
            Ask
            <span aria-hidden>↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ClearAllButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        data-testid="clear-all"
        className="rounded-md px-2 py-1 text-xs font-medium text-ink-faint transition-colors hover:bg-canvas-raised hover:text-ink"
      >
        Clear all
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs" data-testid="clear-all-confirm">
      <span className="text-ink-muted">Clear all questions?</span>
      <button
        type="button"
        onClick={onConfirm}
        data-testid="clear-all-confirm-yes"
        className="rounded-md bg-confidence-low/15 px-2 py-1 font-semibold text-confidence-low transition-colors hover:bg-confidence-low/25"
      >
        Clear
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-md px-2 py-1 font-medium text-ink-faint transition-colors hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}

function EmptyState({
  onPick,
  starters,
}: {
  onPick: (q: string) => void;
  starters: CorpusStarterQuestion[];
}) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center">
      <h1 className="font-display text-[28px] font-medium tracking-tight text-ink">Ask the corpus.</h1>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-muted">
        Answers are grounded in retrieved passages with inline citations — the system declines to
        answer rather than invent when the evidence isn&apos;t there.
      </p>
      {starters.length > 0 && (
        <div className="mt-8 grid w-full max-w-xl gap-2.5">
          {starters.map((q) => (
            <button
              key={q.text}
              type="button"
              onClick={() => onPick(q.text)}
              data-testid="starter-question"
              className="group flex items-center justify-between gap-3 rounded-card border border-border bg-canvas-raised px-4 py-3 text-left shadow-panel transition-colors hover:border-accent/40 hover:bg-accent-soft/40"
            >
              <span className="text-sm text-ink">{q.text}</span>
              <span className="shrink-0 rounded-full bg-canvas-sunken px-2 py-0.5 text-[11px] font-medium text-ink-faint group-hover:text-accent-ink">
                {q.hint}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnBlock({ turn, onRemove }: { turn: Turn; onRemove: () => void }) {
  const { phase, result, retrieval } = turn;
  const isDone = phase === "done";
  const answered = isDone ? result?.answered ?? false : retrieval?.answered ?? true;
  const showRefusal = isDone && result && !result.answered;
  // While finishing an off-corpus question, don't flash the answer layout.
  const knownRefusing = !isDone && retrieval !== undefined && !retrieval.answered;
  const sources = result?.sources ?? retrieval?.sources ?? [];

  return (
    <div
      className="group/turn relative animate-fade-in border-t border-border pt-6 first:border-t-0 first:pt-0"
      data-testid="chat-turn"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-[17px] font-medium leading-snug text-ink">{turn.question}</h2>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this question"
          data-testid="remove-turn"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-ink-faint opacity-0 transition-all hover:border-border hover:text-confidence-low focus-visible:opacity-100 group-hover/turn:opacity-100"
        >
          <RemoveIcon />
        </button>
      </div>

      {phase === "error" && (
        <div className="mt-3 rounded-card border border-confidence-low/30 bg-canvas-raised p-4 text-sm text-confidence-low">
          {turn.error ?? "Something went wrong."}
        </div>
      )}

      {phase !== "error" && showRefusal && (
        <div className="mt-4">
          <RefusalPanel result={result} />
        </div>
      )}

      {phase !== "error" && !showRefusal && (knownRefusing ? (
        <div className="mt-4">
          <StageStrip turn={turn} refusing />
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[1fr,320px]">
          <div className="min-w-0 space-y-5">
            {isDone && result ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <ConfidenceIndicator result={result} />
                  <span className="font-mono text-[11px] text-ink-faint">
                    {formatLatency(result.latency_ms)} · {result.backend}
                  </span>
                  <FeedbackControl turn={turn} className="ml-auto" />
                </div>
                <AnswerRenderer answer={result.answer} citations={result.citations} />
                <GraphPathsList paths={result.graph_paths} />
              </>
            ) : phase === "streaming" ? (
              <>
                <StageStrip turn={turn} />
                <StreamingAnswer text={turn.streamedText} />
              </>
            ) : (
              <StageStrip turn={turn} />
            )}
          </div>
          <aside className="min-w-0">
            {answered && sources.length > 0 ? (
              <SourcesPanel sources={sources} title="Sources" />
            ) : (
              <SourcesSkeleton />
            )}
          </aside>
        </div>
      ))}
    </div>
  );
}

/**
 * The staged status shown while a question is in flight. The labels reflect what
 * the system is genuinely doing: searching the corpus, then retrieval landing
 * with real counts, then handing the grounded context to the answer model.
 */
function StageStrip({ turn, refusing = false }: { turn: Turn; refusing?: boolean }) {
  const { phase, retrieval } = turn;
  const searching = phase === "searching";
  const hasRetrieval = retrieval !== undefined;
  const nPassages = retrieval?.sources.length ?? 0;
  const nPaths = retrieval?.graph_paths.length ?? 0;
  const asking = phase === "generating" || phase === "streaming";

  return (
    <ol className="space-y-2.5" data-testid="stage-strip" aria-live="polite">
      <Stage state={searching ? "active" : "done"} label="Searching the corpus" />
      <Stage
        state={hasRetrieval ? "done" : "pending"}
        label={
          hasRetrieval
            ? `${nPassages} ${nPassages === 1 ? "passage" : "passages"} · ${nPaths} graph ${
                nPaths === 1 ? "path" : "paths"
              } retrieved`
            : "Retrieving passages + graph paths"
        }
      />
      {refusing ? (
        <Stage state="active" label="Off-corpus — preparing decline" />
      ) : (
        <Stage
          state={phase === "streaming" ? "done" : asking ? "active" : "pending"}
          label={`Asking ${modelLabel(retrieval?.backend ?? "")}`}
        />
      )}
    </ol>
  );
}

function Stage({ state, label }: { state: "pending" | "active" | "done"; label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
        {state === "active" && <Spinner />}
        {state === "done" && <CheckIcon />}
        {state === "pending" && <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />}
      </span>
      <span className={state === "pending" ? "text-ink-faint" : state === "active" ? "text-ink" : "text-ink-muted"}>
        {label}
      </span>
    </li>
  );
}

function StreamingAnswer({ text }: { text: string }) {
  return (
    <div className="space-y-3" data-testid="streaming-answer">
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
        {cleanStreaming(text)}
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-accent align-baseline"
        />
      </p>
    </div>
  );
}

/** Light, display-only tidy of in-flight prose (the final answer is cleaned server-side). */
function cleanStreaming(text: string): string {
  return text
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/(^|\n)(\s*)[*-]\s+/g, "$1$2• "); // bullets → •, matching the final answer
}

function SourcesSkeleton() {
  return (
    <div data-testid="sources-skeleton">
      <div className="mb-3 h-3 w-16 animate-pulse rounded bg-canvas-sunken" />
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-card border border-border bg-canvas-raised p-3 shadow-panel">
            <div className="h-3 w-2/3 animate-pulse rounded bg-canvas-sunken" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-canvas-sunken" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin text-accent" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 text-tier-formal" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
