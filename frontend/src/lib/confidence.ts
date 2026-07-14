import type { Confidence, Verdict } from "@/api/types";

export interface ConfidenceMeta {
  label: string;
  verdictLabel: string;
  colorVar: string;
  softVar: string;
  description: string;
}

const META: Record<Confidence, ConfidenceMeta> = {
  high: {
    label: "High confidence",
    verdictLabel: "Sufficient",
    colorVar: "var(--color-confidence-high)",
    softVar: "var(--color-tier-formal-soft)",
    description: "Retrieval found strong, well-anchored evidence for this question.",
  },
  medium: {
    label: "Medium confidence",
    verdictLabel: "Borderline",
    colorVar: "var(--color-confidence-medium)",
    softVar: "var(--color-tier-unverified-soft)",
    description: "Retrieval found partial evidence — treat the answer as a lead, not a certainty.",
  },
  low: {
    label: "Low confidence",
    verdictLabel: "Insufficient",
    colorVar: "var(--color-confidence-low)",
    softVar: "var(--color-tier-informal-soft)",
    description: "Retrieval did not find enough grounded evidence to answer.",
  },
};

export function confidenceMeta(confidence: Confidence): ConfidenceMeta {
  return META[confidence];
}

export function verdictToConfidence(verdict: Verdict): Confidence {
  if (verdict === "sufficient") return "high";
  if (verdict === "borderline") return "medium";
  return "low";
}
