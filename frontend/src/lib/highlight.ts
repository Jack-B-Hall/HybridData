export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Given a section's body text and its absolute offset into the full
 * document, return the [start,end) slice of `body` (local offsets) that
 * overlaps the requested absolute highlight range, if any.
 */
export function localHighlightRange(
  sectionStart: number,
  bodyLength: number,
  highlight: HighlightRange | undefined,
): HighlightRange | null {
  if (!highlight) return null;
  const sectionEnd = sectionStart + bodyLength;
  const start = Math.max(highlight.start, sectionStart);
  const end = Math.min(highlight.end, sectionEnd);
  if (start >= end) return null;
  return { start: start - sectionStart, end: end - sectionStart };
}

/** First markdown heading line in a block of text, if any. */
export function firstHeading(text: string): string | null {
  const match = /^#{1,6}\s+(.+)$/m.exec(text);
  return match ? match[1]!.trim() : null;
}
