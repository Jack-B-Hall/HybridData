import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Citation, ProvTierLabel, Source } from "@/api/types";

/** The passage a drawer opens to — everything needed to show and locate it. */
export interface DrawerTarget {
  artifactId: string;
  title: string;
  source: string;
  tierLabel: ProvTierLabel;
  chunkIdx: number;
  charStart: number;
  charEnd: number;
  /** The grounding snippet, shown immediately while the full document loads. */
  passage: string;
}

export function targetFromSource(source: Source): DrawerTarget {
  return {
    artifactId: source.artifact_id,
    title: source.title,
    source: source.source,
    tierLabel: source.tier_label,
    chunkIdx: source.chunk_idx,
    charStart: source.char_start,
    charEnd: source.char_end,
    passage: source.body,
  };
}

export function targetFromCitation(citation: Citation): DrawerTarget {
  return {
    artifactId: citation.artifact_id,
    title: citation.title,
    source: citation.source,
    tierLabel: citation.tier_label,
    chunkIdx: citation.chunk_idx,
    charStart: citation.char_start,
    charEnd: citation.char_end,
    passage: citation.passage,
  };
}

interface DrawerContextValue {
  target: DrawerTarget | null;
  open: (target: DrawerTarget) => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const open = useCallback((next: DrawerTarget) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ target, open, close }), [target, open, close]);
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within a DrawerProvider");
  return ctx;
}
