import { useRef, useState } from "react";
import { api } from "@/api";
import type { AskResult } from "@/api/types";
import { AnswerRenderer } from "@/components/AnswerRenderer";
import { ConfidenceIndicator } from "@/components/ConfidenceIndicator";
import { SourcesPanel } from "@/components/SourcesPanel";
import { RefusalPanel } from "@/components/RefusalPanel";
import { GraphPathsList } from "@/components/GraphPathsList";
import { formatLatency } from "@/lib/format";

const STARTER_QUESTIONS = [
  {
    text: "Why was the K-200 battery chemistry changed from LiPo to LiFePO4?",
    hint: "Change history",
  },
  {
    text: "If ECR-221 changes the propulsion motors, what parts and documents are affected?",
    hint: "Impact analysis",
  },
  {
    text: "What is the capital of France?",
    hint: "Off-corpus — demonstrates refusal",
  },
];

interface Turn {
  id: number;
  question: string;
  status: "loading" | "done" | "error";
  result?: AskResult;
  error?: string;
}

let turnId = 0;

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  async function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    const id = ++turnId;
    setTurns((prev) => [...prev, { id, question: trimmed, status: "loading" }]);
    setDraft("");
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }));

    try {
      const result = await api.ask(trimmed);
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, status: "done", result } : t)));
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: "error", error: err instanceof Error ? err.message : "Request failed" } : t,
        ),
      );
    }
  }

  return (
    <div className="relative flex min-h-[calc(100vh-8.5rem)] flex-col">
      <div ref={listRef} className="flex-1 space-y-8 overflow-y-auto pb-28">
        {turns.length === 0 ? (
          <EmptyState onPick={submit} />
        ) : (
          turns.map((turn) => <TurnBlock key={turn.id} turn={turn} />)
        )}
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-canvas to-transparent"
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft);
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
                void submit(draft);
              }
            }}
            rows={1}
            placeholder="Ask about the K-200 programme — parts, changes, decisions, incidents…"
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

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center">
      <h1 className="font-display text-[28px] font-medium tracking-tight text-ink">
        Ask the corpus.
      </h1>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-muted">
        Answers are grounded in retrieved passages with inline citations — the system declines to
        answer rather than invent when the evidence isn&apos;t there.
      </p>
      <div className="mt-8 grid w-full max-w-xl gap-2.5">
        {STARTER_QUESTIONS.map((q) => (
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
    </div>
  );
}

function TurnBlock({ turn }: { turn: Turn }) {
  return (
    <div className="animate-fade-in border-t border-border pt-6 first:border-t-0 first:pt-0" data-testid="chat-turn">
      <h2 className="font-display text-[17px] font-medium leading-snug text-ink">{turn.question}</h2>

      {turn.status === "loading" && <LoadingBlock />}

      {turn.status === "error" && (
        <div className="mt-3 rounded-card border border-confidence-low/30 bg-canvas-raised p-4 text-sm text-confidence-low">
          {turn.error ?? "Something went wrong."}
        </div>
      )}

      {turn.status === "done" && turn.result && (
        <div className="mt-4">
          {!turn.result.answered ? (
            <RefusalPanel result={turn.result} />
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr,320px]">
              <div className="min-w-0 space-y-5">
                <div className="flex flex-wrap items-center gap-3">
                  <ConfidenceIndicator result={turn.result} />
                  <span className="font-mono text-[11px] text-ink-faint">
                    {formatLatency(turn.result.latency_ms)} · {turn.result.backend}
                  </span>
                </div>
                <AnswerRenderer answer={turn.result.answer} citations={turn.result.citations} />
                <GraphPathsList paths={turn.result.graph_paths} />
              </div>
              <aside className="min-w-0">
                <SourcesPanel sources={turn.result.sources} title="Sources" />
              </aside>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="mt-4 animate-fade-in space-y-3" data-testid="chat-loading" aria-busy="true">
      <div className="h-6 w-40 animate-pulse rounded-full bg-canvas-sunken" />
      <div className="h-4 w-full animate-pulse rounded bg-canvas-sunken" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-canvas-sunken" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-canvas-sunken" />
    </div>
  );
}
