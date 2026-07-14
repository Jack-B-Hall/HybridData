import { parseAnswer } from "@/lib/citations";
import type { Citation } from "@/api/types";
import { CitationChip } from "./CitationChip";

export interface AnswerRendererProps {
  answer: string;
  citations: Citation[];
}

/** Renders answer prose, turning inline `[n]` markers into citation chips. */
export function AnswerRenderer({ answer, citations }: AnswerRendererProps) {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const paragraphs = parseAnswer(answer);

  return (
    <div className="space-y-3" data-testid="answer-body">
      {paragraphs.map((paragraph, i) => (
        <p
          key={i}
          className={
            paragraph.heading
              ? "font-display text-lg font-medium text-ink"
              : "text-[15px] leading-relaxed text-ink"
          }
        >
          {paragraph.parts.map((part, j) =>
            part.type === "text" ? (
              <span key={j}>{part.value}</span>
            ) : (
              <CitationChip
                key={j}
                citation={
                  byMarker.get(part.marker) ?? {
                    marker: part.marker,
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
            ),
          )}
        </p>
      ))}
    </div>
  );
}
