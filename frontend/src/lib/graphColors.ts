import type { ArtifactKind, ProvTierLabel } from "@/api/types";

/** Categorical palette for graph node *kind* — deliberately distinct from
 * the provenance-tier palette (emerald/amber/violet) used elsewhere, so the
 * two color systems never collide in views that show both. */
export const NODE_KIND_COLOR: Record<ArtifactKind, string> = {
  document: "#3f7fd6",
  entity: "#d97a34",
  person: "#c2508a",
};

export const NODE_KIND_LABEL: Record<ArtifactKind, string> = {
  document: "Document",
  entity: "Entity",
  person: "Person",
};

export function tierFromProvTier(tier: number): ProvTierLabel {
  if (tier <= 1) return "formal";
  if (tier === 2) return "unverified";
  return "informal";
}
