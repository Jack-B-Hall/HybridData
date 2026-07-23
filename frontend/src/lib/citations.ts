export interface TextPart {
  type: "text";
  value: string;
}

export interface CitationPart {
  type: "citation";
  marker: number;
}

export type AnswerPart = TextPart | CitationPart;

const MARKER_RE = /\[(\d+)\]/g;

/** Split a single line of prose into alternating text/citation-marker parts. */
export function parseInlineCitations(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let lastIndex = 0;
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "citation", marker: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }
  return parts;
}

/** Extract the set of citation markers referenced anywhere in the answer. */
export function citationMarkersIn(answer: string): number[] {
  const markers = new Set<number>();
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(answer))) {
    markers.add(Number(match[1]));
  }
  return [...markers].sort((a, b) => a - b);
}
