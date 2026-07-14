export interface TextPart {
  type: "text";
  value: string;
}

export interface CitationPart {
  type: "citation";
  marker: number;
}

export type AnswerPart = TextPart | CitationPart;

export interface AnswerParagraph {
  heading: boolean;
  parts: AnswerPart[];
}

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

/**
 * Parse the full answer string (markdown-ish prose with inline `[n]`
 * markers) into paragraphs. A leading `#`..`######` on a line is treated as
 * a soft heading emphasis rather than full markdown heading semantics,
 * since the deterministic mock LLM sometimes splices a source document's
 * `# Title` line directly into the answer.
 */
export function parseAnswer(answer: string): AnswerParagraph[] {
  return answer
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const headingMatch = /^#{1,6}\s+/.exec(line);
      const heading = headingMatch !== null;
      const content = heading ? line.slice(headingMatch![0].length) : line;
      return { heading, parts: parseInlineCitations(stripStrayHeadingMarkers(content)) };
    });
}

/**
 * The deterministic mock LLM sometimes splices a source's `# Title` opening
 * line directly mid-sentence (e.g. "...ECN-312. [2] # K-200 Battery System
 * Specification [3]"). A leading heading on its own line is handled by
 * `parseAnswer` above; this strips any *other* stray `#`..`######` markers
 * so raw hash characters never leak into rendered prose.
 */
function stripStrayHeadingMarkers(text: string): string {
  return text
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
