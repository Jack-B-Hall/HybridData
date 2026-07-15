import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { api } from "@/api";
import type { AskResult, FeedbackRating, RetrievalEvent } from "@/api/types";

export type TurnPhase = "searching" | "generating" | "streaming" | "done" | "error";

export interface TurnFeedback {
  rating: FeedbackRating;
  comment?: string;
  /** True once the POST /api/feedback round-trip has succeeded. */
  saved: boolean;
}

export interface Turn {
  id: number;
  question: string;
  phase: TurnPhase;
  /** Retrieval snapshot (sources, verdict, graph paths, backend) once available. */
  retrieval?: RetrievalEvent;
  /** Raw prose accumulated while the model streams, shown before `result` lands. */
  streamedText: string;
  result?: AskResult;
  error?: string;
  /** Thumbs feedback the user gave on this answer; persists across tab nav. */
  feedback?: TurnFeedback;
  /** Collapsed to a compact row; persists across tab nav. */
  collapsed?: boolean;
}

interface ChatContextValue {
  turns: Turn[];
  draft: string;
  setDraft: (value: string) => void;
  submit: (question: string) => void;
  removeTurn: (id: number) => void;
  clearAll: () => void;
  submitFeedback: (turnId: number, rating: FeedbackRating, comment?: string) => void;
  toggleCollapse: (id: number) => void;
  /** Persisted scroll offset so the list restores position across tab changes. */
  scrollTopRef: React.MutableRefObject<number>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

let nextTurnId = 0;

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const scrollTopRef = useRef(0);
  // Mirror of `turns` for reads inside async callbacks without stale closures.
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  // One AbortController per in-flight turn, so removing/clearing cancels its stream.
  const controllers = useRef(new Map<number, AbortController>());

  const patchTurn = useCallback((id: number, patch: (t: Turn) => Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? patch(t) : t)));
  }, []);

  const submit = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      const id = ++nextTurnId;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      setTurns((prev) => [...prev, { id, question: trimmed, phase: "searching", streamedText: "" }]);
      setDraft("");

      const finish = () => controllers.current.delete(id);

      void api.askStream(
        trimmed,
        {
          onRetrieval: (event: RetrievalEvent) => {
            patchTurn(id, (t) => ({
              ...t,
              retrieval: event,
              phase: event.answered ? "generating" : t.phase,
            }));
          },
          onToken: (delta: string) => {
            patchTurn(id, (t) => ({
              ...t,
              phase: "streaming",
              streamedText: t.streamedText + delta,
            }));
          },
          onDone: (result: AskResult) => {
            patchTurn(id, (t) => ({ ...t, phase: "done", result }));
            finish();
          },
          onError: (message: string) => {
            patchTurn(id, (t) => ({ ...t, phase: "error", error: message }));
            finish();
          },
        },
        controller.signal,
      );
    },
    [patchTurn],
  );

  const removeTurn = useCallback((id: number) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setTurns((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
    setTurns([]);
  }, []);

  const toggleCollapse = useCallback((id: number) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, collapsed: !t.collapsed } : t)));
  }, []);

  const submitFeedback = useCallback(
    (turnId: number, rating: FeedbackRating, comment?: string) => {
      const trimmed = comment?.trim() || undefined;
      // Optimistic: show the rating immediately, mark saved once it round-trips.
      patchTurn(turnId, (t) => ({ ...t, feedback: { rating, comment: trimmed, saved: false } }));
      const askId = turnsRef.current.find((t) => t.id === turnId)?.result?.ask_id;
      if (!askId) return;
      api
        .submitFeedback({ ask_id: askId, rating, comment: trimmed })
        .then(() => patchTurn(turnId, (t) => ({ ...t, feedback: { rating, comment: trimmed, saved: true } })))
        .catch(() => {
          /* keep the optimistic rating; saved stays false */
        });
    },
    [patchTurn],
  );

  const value = useMemo(
    () => ({
      turns, draft, setDraft, submit, removeTurn, clearAll, submitFeedback, toggleCollapse, scrollTopRef,
    }),
    [turns, draft, submit, removeTurn, clearAll, submitFeedback, toggleCollapse],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within a ChatProvider");
  return ctx;
}
