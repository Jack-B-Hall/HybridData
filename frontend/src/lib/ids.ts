// Artifact ids look like ECR-214, DOC-421, P-1062, KES-208, WIKI-052, or E01.
// Mirrors the backend id shape: 1–6 uppercase letters, an optional dash, digits.
const ID_RE = /^\s*([A-Z][A-Z0-9]*-?\d+)/;

/**
 * Pull the leading artifact id out of a graph-path segment such as
 * `"ECR-214 (Battery cell chemistry change: P-1062 Li)"` → `"ECR-214"`.
 * Returns null when the segment doesn't start with an id.
 */
export function extractNodeId(segment: string): string | null {
  const match = ID_RE.exec(segment);
  return match ? match[1]! : null;
}
