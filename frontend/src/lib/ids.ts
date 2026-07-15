// The corpus's record-id shape is configurable (see /api/corpus/meta.id_pattern),
// so graph-path click-through matches whatever ids the real data uses. We try the
// configured pattern first, then fall back to a permissive default — the default
// also catches ids the backend pattern intentionally omits (e.g. person ids like
// `E01`, which have no hyphen), so the demo never regresses.
const DEFAULT_LEADING_RE = /^\s*([A-Z][A-Z0-9]*-?\d+)/;

/** Anchor a backend id pattern (word-boundary form) as a leading-id matcher. */
function leadingReFor(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp("^\\s*(" + pattern.replace(/\\b/g, "") + ")");
  } catch {
    return null;
  }
}

/**
 * Pull the leading artifact id out of a graph-path segment such as
 * `"ECR-214 (Battery cell chemistry change: P-1062 Li)"` → `"ECR-214"`.
 * Pass the corpus's `id_pattern` to match non-default id shapes; returns null
 * when the segment doesn't start with an id.
 */
export function extractNodeId(segment: string, pattern?: string): string | null {
  const configured = leadingReFor(pattern);
  const match = (configured && configured.exec(segment)) || DEFAULT_LEADING_RE.exec(segment);
  return match ? match[1]! : null;
}
