import { useState } from "react";
import { useChat, type Turn, type TurnFeedback } from "@/store/chat";
import type { FeedbackRating } from "@/api/types";

export interface FeedbackControlProps {
  turn: Turn;
  className?: string;
}

/**
 * Thumbs up/down on an answer, sitting beside the confidence pill. A thumbs-down
 * opens a small optional comment box before it is sent. The chosen rating lives
 * in chat state, so it survives navigating away and back.
 */
export function FeedbackControl({ turn, className = "" }: FeedbackControlProps) {
  const { submitFeedback } = useChat();

  const askId = turn.result?.ask_id ?? 0;
  if (askId <= 0) return null; // not logged → nothing to attach feedback to

  return (
    <FeedbackButtons
      feedback={turn.feedback}
      onRate={(rating, comment) => submitFeedback(turn.id, rating, comment)}
      className={className}
    />
  );
}

export interface FeedbackButtonsProps {
  feedback?: TurnFeedback;
  onRate: (rating: FeedbackRating, comment?: string) => void;
  className?: string;
}

/**
 * The presentational thumbs control, decoupled from the Interface tab's chat
 * store so the multi-turn Chat page reuses the exact same UI. The wrapper
 * above keeps the original single-shot behaviour untouched.
 */
export function FeedbackButtons({ feedback, onRate, className = "" }: FeedbackButtonsProps) {
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");

  const rating = feedback?.rating;

  function chooseUp() {
    setCommenting(false);
    onRate("up");
  }

  function chooseDown() {
    setComment(feedback?.comment ?? "");
    setCommenting(true);
  }

  function sendDown() {
    onRate("down", comment);
    setCommenting(false);
  }

  return (
    <div className={`relative flex items-center gap-1 ${className}`} data-testid="feedback-control">
      {feedback?.saved && !commenting && (
        <span className="mr-1 text-[11px] text-ink-faint" data-testid="feedback-thanks">
          Thanks
        </span>
      )}
      <ThumbButton direction="up" active={rating === "up"} onClick={chooseUp} testId="feedback-up" />
      <ThumbButton direction="down" active={rating === "down"} onClick={chooseDown} testId="feedback-down" />

      {commenting && (
        // Absolutely positioned so opening it never reflows the answer header.
        <div
          className="absolute right-0 top-full z-20 mt-2 w-64 animate-fade-in rounded-card border border-border bg-canvas-overlay p-2.5 shadow-popover"
          data-testid="feedback-comment"
        >
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="What was off? (optional)"
            data-testid="feedback-comment-input"
            className="w-full resize-none rounded-md border border-border bg-canvas-raised px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setCommenting(false)}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={sendDown}
              data-testid="feedback-comment-send"
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-canvas-raised transition-colors hover:bg-accent-strong"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThumbButton({
  direction,
  active,
  onClick,
  testId,
}: {
  direction: "up" | "down";
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      aria-label={direction === "up" ? "Helpful answer" : "Unhelpful answer"}
      className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
        active
          ? direction === "up"
            ? "border-tier-formal/40 bg-tier-formal-soft text-tier-formal"
            : "border-confidence-low/40 bg-confidence-low/10 text-confidence-low"
          : "border-transparent text-ink-faint hover:border-border hover:text-ink"
      }`}
    >
      <ThumbIcon down={direction === "down"} />
    </button>
  );
}

function ThumbIcon({ down }: { down: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={down ? { transform: "rotate(180deg)" } : undefined}
    >
      <path
        d="M5.5 7.5v5.5H3.2a.7.7 0 0 1-.7-.7V8.2a.7.7 0 0 1 .7-.7H5.5Zm0 0 2.6-5a1.4 1.4 0 0 1 1.9 1.7l-.7 2.3h3a1.2 1.2 0 0 1 1.2 1.5l-1 3.8a1.6 1.6 0 0 1-1.5 1.2H5.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
