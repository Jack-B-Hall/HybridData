import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import type {
  ChatTurn,
  ConversationSummary,
  FeedbackRating,
  RetrievalEvent,
} from "@/api/types";
import { AnswerRenderer } from "@/components/AnswerRenderer";
import { ConfidenceIndicator } from "@/components/ConfidenceIndicator";
import { FeedbackButtons } from "@/components/FeedbackControl";
import { GraphPathsList } from "@/components/GraphPathsList";
import { RefusalPanel } from "@/components/RefusalPanel";
import { SourcesPanel } from "@/components/SourcesPanel";
import { formatLatency, modelLabel } from "@/lib/format";
import type { TurnFeedback } from "@/store/chat";

type TurnPhase = "searching" | "generating" | "streaming" | "done" | "error";

/** One thread entry: a persisted turn, or a turn currently in flight. */
interface ThreadTurn {
  key: number;
  /** Conversation this turn belongs to (guards merges + aborts across switches). */
  cid: number;
  message: string;
  phase: TurnPhase;
  rewritten?: string;
  retrieval?: RetrievalEvent;
  streamedText: string;
  turn?: ChatTurn;
  error?: string;
  feedback?: TurnFeedback;
}

let nextKey = 0;

/**
 * The multi-turn Chat tab. Conversations persist server-side; every turn is
 * condensed to a standalone question, retrieved + gated fresh, and answered
 * with citations, so follow-ups keep the Interface tab's grounding guarantees.
 */
export function ConversationsPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [thread, setThread] = useState<ThreadTurn[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const controllers = useRef(new Map<number, { cid: number; controller: AbortController }>());
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  // A turn is in flight in the current thread: block a second send until it
  // lands, so the follow-up's condensation window can see the previous turn.
  const busy = thread.some((t) => t.phase !== "done" && t.phase !== "error");
  const busyRef = useRef(false);
  busyRef.current = busy;

  /** Abort in-flight streams, optionally only those of one conversation. */
  const abortStreams = useCallback((onlyCid?: number) => {
    for (const [key, entry] of controllers.current) {
      if (onlyCid === undefined || entry.cid === onlyCid) {
        entry.controller.abort();
        controllers.current.delete(key);
      }
    }
  }, []);

  // Abort everything still streaming when the page unmounts.
  useEffect(() => {
    return () => abortStreams();
  }, [abortStreams]);

  const refreshConversations = useCallback(async () => {
    const res = await api.getConversations();
    setConversations(res.conversations);
    return res.conversations;
  }, []);

  // Initial load: list conversations and open the most recent one.
  useEffect(() => {
    let cancelled = false;
    refreshConversations()
      .then((list) => {
        if (!cancelled && list.length > 0) setSelectedId((cur) => cur ?? list[0]!.id);
      })
      .catch(() => {
        /* empty sidebar; composer still creates a conversation on first send */
      });
    return () => {
      cancelled = true;
    };
  }, [refreshConversations]);

  // Load the selected conversation's turns. Streams belonging to any OTHER
  // conversation are aborted; turns still in flight for THIS conversation are
  // kept on top of the fetched history rather than clobbered (on first send in
  // a just-created conversation the server has no turns yet: the turn is only
  // persisted at the `done` event, so replacing the thread with the fetch
  // result would wipe the streaming turn from view).
  useEffect(() => {
    for (const [key, entry] of controllers.current) {
      if (entry.cid !== selectedId) {
        entry.controller.abort();
        controllers.current.delete(key);
      }
    }
    if (selectedId === null) {
      setThread([]);
      return;
    }
    let cancelled = false;
    setLoadingThread(true);
    // Local turns worth keeping: same conversation and either not yet persisted
    // (in flight, or an unsaved error turn) or persisted but missing from the
    // fetched snapshot (the stream finished while the fetch was in flight).
    const keepLocal = (prev: ThreadTurn[], fetchedIds: Set<number>) =>
      prev.filter(
        (t) => t.cid === selectedId && (t.turn === undefined || !fetchedIds.has(t.turn.id)),
      );
    api
      .getConversation(selectedId)
      .then((detail) => {
        if (cancelled) return;
        const ok = detail.turns.filter((t) => t.status === "ok");
        const fetchedIds = new Set(ok.map((t) => t.id));
        setThread((prev) => [
          ...ok.map((t) => ({
            key: ++nextKey,
            cid: selectedId,
            message: t.message,
            phase: "done" as const,
            rewritten: t.rewritten,
            streamedText: "",
            turn: t,
          })),
          ...keepLocal(prev, fetchedIds),
        ]);
      })
      .catch(() => !cancelled && setThread((prev) => keepLocal(prev, new Set())))
      .finally(() => !cancelled && setLoadingThread(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Keep the newest turn in view as it streams in.
  const threadLen = thread.length;
  const lastPhase = thread[threadLen - 1]?.phase;
  useEffect(() => {
    requestAnimationFrame(() => {
      const blocks = threadRef.current?.querySelectorAll('[data-testid="chat-assistant-turn"]');
      const last = blocks?.[blocks.length - 1] as HTMLElement | undefined;
      // Optional call: jsdom (vitest) has no scrollIntoView.
      last?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  }, [threadLen, lastPhase]);

  const patchTurn = useCallback((key: number, patch: (t: ThreadTurn) => ThreadTurn) => {
    setThread((prev) => prev.map((t) => (t.key === key ? patch(t) : t)));
  }, []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || busyRef.current) return;
      setDraft("");

      let cid = selectedRef.current;
      if (cid === null) {
        try {
          const convo = await api.createConversation();
          cid = convo.id;
          setSelectedId(cid);
          setConversations((prev) => [convo, ...prev]);
        } catch {
          return; // backend unreachable; leave the draft area usable
        }
      }

      const key = ++nextKey;
      const controller = new AbortController();
      controllers.current.set(key, { cid, controller });
      setThread((prev) => [...prev, { key, cid, message: trimmed, phase: "searching", streamedText: "" }]);

      const finish = () => {
        controllers.current.delete(key);
        void refreshConversations().catch(() => undefined);
      };

      void api.chatMessageStream(
        cid,
        trimmed,
        {
          onRewrite: (event) => {
            patchTurn(key, (t) => ({ ...t, rewritten: event.rewritten }));
          },
          onRetrieval: (event) => {
            patchTurn(key, (t) => ({
              ...t,
              retrieval: event,
              phase: event.answered ? "generating" : t.phase,
            }));
          },
          onToken: (delta) => {
            patchTurn(key, (t) => ({ ...t, phase: "streaming", streamedText: t.streamedText + delta }));
          },
          onDone: (turn) => {
            patchTurn(key, (t) => ({ ...t, phase: "done", turn }));
            finish();
          },
          onError: (msg) => {
            patchTurn(key, (t) => ({ ...t, phase: "error", error: msg }));
            finish();
          },
        },
        controller.signal,
      );
    },
    [patchTurn, refreshConversations],
  );

  const newConversation = useCallback(async () => {
    try {
      const convo = await api.createConversation();
      setConversations((prev) => [convo, ...prev]);
      setSelectedId(convo.id);
    } catch {
      /* keep current selection */
    }
  }, []);

  const renameConversation = useCallback(async (id: number, title: string) => {
    try {
      await api.renameConversation(id, title);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch {
      /* keep the old title */
    }
  }, []);

  const deleteConversation = useCallback(
    async (id: number) => {
      try {
        await api.deleteConversation(id);
      } catch {
        return;
      }
      abortStreams(id);
      setConversations((prev) => {
        const rest = prev.filter((c) => c.id !== id);
        if (selectedRef.current === id) setSelectedId(rest[0]?.id ?? null);
        return rest;
      });
    },
    [abortStreams],
  );

  const submitFeedback = useCallback(
    (key: number, askId: number, rating: FeedbackRating, comment?: string) => {
      const trimmed = comment?.trim() || undefined;
      patchTurn(key, (t) => ({ ...t, feedback: { rating, comment: trimmed, saved: false } }));
      api
        .submitFeedback({ ask_id: askId, rating, comment: trimmed })
        .then(() => patchTurn(key, (t) => ({ ...t, feedback: { rating, comment: trimmed, saved: true } })))
        .catch(() => {
          /* keep the optimistic rating; saved stays false */
        });
    },
    [patchTurn],
  );

  return (
    <div className="flex min-h-[calc(100vh-8.5rem)] gap-6">
      <ConversationSidebar
        conversations={conversations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={newConversation}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />

      <section className="relative flex min-w-0 flex-1 flex-col">
        <div ref={threadRef} className="flex-1 overflow-y-auto pb-28">
          <div className="mx-auto w-full max-w-[880px] space-y-7">
          {thread.length === 0 && !loadingThread ? (
            <EmptyThread />
          ) : (
            thread.map((t) => (
              <TurnView key={t.key} turn={t} onRate={(rating, comment) => {
                const askId = t.turn?.result?.ask_id ?? 0;
                if (askId > 0) submitFeedback(t.key, askId, rating, comment);
              }} />
            ))
          )}
          </div>
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-canvas to-transparent"
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
          className="sticky bottom-4 mx-auto mt-4 w-full max-w-[880px]"
        >
          <div className="flex items-end gap-2 rounded-card border border-border-strong bg-canvas-raised p-2 shadow-popover focus-within:border-accent">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={1}
              placeholder={busy ? "Waiting for the current answer…" : "Message the corpus, follow-ups welcome…"}
              data-testid="chat-composer-input"
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <button
              type="submit"
              data-testid="chat-composer-send"
              disabled={!draft.trim() || busy}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-semibold text-canvas-raised transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-ink-faint"
            >
              Send
              <span aria-hidden>↵</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
function ConversationSidebar({
  conversations,
  selectedId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <aside
      className="sticky top-20 flex max-h-[calc(100vh-7rem)] w-64 shrink-0 flex-col self-start"
      data-testid="conversation-sidebar"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Conversations</h2>
        <button
          type="button"
          onClick={onNew}
          data-testid="new-conversation"
          className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          <PlusIcon />
          New
        </button>
      </div>
      {conversations.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">
          No conversations yet. Send a message to start one.
        </p>
      ) : (
        <ul className="space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
              onRename={(title) => onRename(c.id, title)}
              onDelete={() => onDelete(c.id)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  const label = conversation.title || "New conversation";

  if (renaming) {
    return (
      <li className="rounded-md border border-accent bg-canvas-raised p-1.5">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim()) {
              onRename(title.trim());
              setRenaming(false);
            }
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={() => setRenaming(false)}
          data-testid="rename-input"
          className="w-full bg-transparent px-1 text-sm text-ink focus:outline-none"
        />
      </li>
    );
  }

  return (
    <li
      className={`group/convo relative rounded-md transition-colors ${
        active ? "bg-canvas-raised shadow-panel" : "hover:bg-canvas-raised"
      }`}
      data-testid="conversation-item"
      data-active={active || undefined}
    >
      <button type="button" onClick={onSelect} className="block w-full px-2.5 py-2 pr-14 text-left">
        <span
          className={`block truncate text-sm ${active ? "font-medium text-ink" : "text-ink-muted"}`}
          data-testid="conversation-title"
        >
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] text-ink-faint">
          {conversation.n_turns} {conversation.n_turns === 1 ? "turn" : "turns"}
        </span>
      </button>
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/convo:opacity-100">
        {confirmingDelete ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Confirm delete"
            data-testid="delete-confirm"
            className="flex h-6 items-center rounded px-1.5 text-[11px] font-semibold text-confidence-low hover:bg-canvas-sunken"
          >
            Delete?
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setTitle(conversation.title ?? "");
                setRenaming(true);
              }}
              aria-label="Rename conversation"
              data-testid="rename-conversation"
              className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-canvas-sunken hover:text-ink"
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              aria-label="Delete conversation"
              data-testid="delete-conversation"
              className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:bg-canvas-sunken hover:text-confidence-low"
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

// ── Thread ──────────────────────────────────────────────────────────────────
function EmptyThread() {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center">
      <h1 className="font-display text-[28px] font-medium tracking-tight text-ink">
        Chat with the corpus.
      </h1>
      <p className="mt-2 max-w-md text-[15px] leading-relaxed text-ink-muted">
        Ask follow-ups naturally. Every turn re-runs retrieval and the evidence gate against a
        condensed, standalone version of your question, so answers stay grounded and cited, and the
        system still declines when the corpus can&apos;t back an answer.
      </p>
    </div>
  );
}

function TurnView({
  turn,
  onRate,
}: {
  turn: ThreadTurn;
  onRate: (rating: FeedbackRating, comment?: string) => void;
}) {
  const { phase, turn: done } = turn;
  const result = done?.result ?? null;
  const rewritten = done?.rewritten ?? turn.rewritten;
  const showRewrite = rewritten !== undefined && rewritten !== turn.message;
  const refusing = phase !== "done" && turn.retrieval !== undefined && !turn.retrieval.answered;

  return (
    <div className="animate-fade-in" data-testid="chat-assistant-turn">
      <div className="flex justify-end">
        <div
          className="max-w-[85%] rounded-card rounded-br-md border border-border bg-canvas-raised px-4 py-2.5 text-sm leading-relaxed text-ink shadow-panel"
          data-testid="chat-user-message"
        >
          {turn.message}
        </div>
      </div>

      <div className="mt-4 min-w-0">
        {showRewrite && (
          <p className="mb-2.5 flex items-center gap-1.5 text-[11px] text-ink-faint" data-testid="rewrite-note">
            <SearchIcon />
            <span>
              searched for: <span className="font-mono text-ink-muted">{rewritten}</span>
            </span>
          </p>
        )}

        {phase === "error" && (
          <div
            className="rounded-card border border-confidence-low bg-canvas-raised p-4 text-sm text-confidence-low"
            data-testid="chat-turn-error"
          >
            {turn.error ?? "Something went wrong."} This turn was not saved; the conversation is
            still usable.
          </div>
        )}

        {phase === "done" && result && !result.answered && <RefusalPanel result={result} />}

        {phase === "done" && result && result.answered && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <ConfidenceIndicator result={result} />
              <span className="font-mono text-[11px] text-ink-faint">
                {formatLatency(result.latency_ms)} · {result.backend}
              </span>
              {(result.ask_id ?? 0) > 0 && (
                <FeedbackButtons feedback={turn.feedback} onRate={onRate} className="ml-auto" />
              )}
            </div>
            <AnswerRenderer answer={result.answer} citations={result.citations} />
            <TurnGraphPaths paths={result.graph_paths} />
            <TurnSources sources={result.sources} />
          </div>
        )}

        {phase !== "done" && phase !== "error" && (
          <div className="space-y-4">
            <StageStrip turn={turn} refusing={refusing} />
            {phase === "streaming" && <StreamingAnswer text={turn.streamedText} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-turn graph paths, collapsed behind a count so the thread stays scannable. */
function TurnGraphPaths({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState(false);
  if (paths.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="graph-paths-toggle"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-ink-faint transition-colors hover:bg-canvas-raised hover:text-ink"
      >
        <ChevronIcon open={open} />
        {paths.length} {paths.length === 1 ? "graph path" : "graph paths"}
      </button>
      {open && (
        <div className="mt-3">
          <GraphPathsList paths={paths} />
        </div>
      )}
    </div>
  );
}

/** Per-turn sources, collapsed behind a count so the thread stays scannable. */
function TurnSources({ sources }: { sources: import("@/api/types").Source[] }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="sources-toggle"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-ink-faint transition-colors hover:bg-canvas-raised hover:text-ink"
      >
        <ChevronIcon open={open} />
        {sources.length} {sources.length === 1 ? "source" : "sources"}
      </button>
      {open && (
        <div className="mt-3 max-w-xl">
          <SourcesPanel sources={sources} title="Sources" />
        </div>
      )}
    </div>
  );
}

function StageStrip({ turn, refusing }: { turn: ThreadTurn; refusing: boolean }) {
  const { phase, retrieval } = turn;
  const hasRetrieval = retrieval !== undefined;
  const nPassages = retrieval?.sources.length ?? 0;
  const nPaths = retrieval?.graph_paths.length ?? 0;
  const asking = phase === "generating" || phase === "streaming";

  return (
    <ol className="space-y-2.5" data-testid="chat-stage-strip" aria-live="polite">
      {/* Searching is over once retrieval lands, even when the gate is
          declining and the phase deliberately stays "searching". */}
      <Stage state={hasRetrieval ? "done" : "active"} label="Searching the corpus" />
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
        <Stage state="active" label="Off-corpus, preparing decline" />
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
  // In-flight prose renders through the same markdown renderer as the final
  // answer (lists and tables take shape as they stream); `[n]` markers show as
  // inert chips until the resolved citations arrive with the final result.
  return (
    <div className="space-y-3" data-testid="chat-streaming-answer">
      <AnswerRenderer answer={text} citations={[]} streaming />
      <span
        aria-hidden
        className="ml-0.5 inline-block h-[1.05em] w-[2px] animate-pulse bg-accent align-baseline"
      />
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────
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

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="m11.3 2.7 2 2L5 13H3v-2l8.3-8.3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4.5h11M6.5 2.5h3M5.5 4.5 6 13.5h4l.5-9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Chevron pointing right when closed, down when open. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="transition-transform"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
