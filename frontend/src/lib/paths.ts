export interface HighlightTarget {
  chunk_idx: number;
  char_start: number;
  char_end: number;
}

/** Build a /documents/:id URL with query params identifying a passage to highlight. */
export function documentHighlightPath(id: string, highlight?: HighlightTarget): string {
  const base = `/documents/${encodeURIComponent(id)}`;
  if (!highlight) return base;
  const params = new URLSearchParams({
    chunk: String(highlight.chunk_idx),
    start: String(highlight.char_start),
    end: String(highlight.char_end),
  });
  return `${base}?${params.toString()}`;
}

export function graphNodePath(id: string): string {
  return `/explorer/graph?node=${encodeURIComponent(id)}`;
}

/**
 * Deep-link to a relationship: focus the `from` node and highlight the edge to
 * `to` (both endpoints emphasised, the typed relationship shown in the inspector).
 */
export function graphEdgePath(from: string, to: string): string {
  return `/explorer/graph?node=${encodeURIComponent(from)}&edge=${encodeURIComponent(to)}`;
}
