import type { ProvTierLabel } from "@/api/types";

const LABEL: Record<ProvTierLabel, string> = {
  formal: "Formal",
  unverified: "Unverified",
  informal: "Informal",
};

const CLASSES: Record<ProvTierLabel, string> = {
  formal: "bg-tier-formal-soft text-tier-formal border-tier-formal/25",
  unverified: "bg-tier-unverified-soft text-tier-unverified border-tier-unverified/25",
  informal: "bg-tier-informal-soft text-tier-informal border-tier-informal/25",
};

export interface TierBadgeProps {
  tier: ProvTierLabel;
  size?: "sm" | "md";
  className?: string;
}

/** Provenance-tier pill. Color is consistent everywhere the tier appears. */
export function TierBadge({ tier, size = "sm", className = "" }: TierBadgeProps) {
  const sizing = size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium leading-none ${sizing} ${CLASSES[tier]} ${className}`}
      data-tier={tier}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {LABEL[tier]}
    </span>
  );
}
