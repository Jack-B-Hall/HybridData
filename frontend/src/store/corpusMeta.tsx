import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/api";
import type { CorpusMeta } from "@/api/types";

// Generic fallback used before the fetch resolves or if the endpoint is absent —
// so the UI never shows demo-specific copy it can't back with real data.
const FALLBACK: CorpusMeta = {
  title: null,
  placeholder: "Ask about the corpus — records, changes, decisions, relationships…",
  starter_questions: [],
  app_name: "Hybrid-Data-Example",
  app_icon: null,
  id_pattern: "\\b[A-Z]{1,6}-\\d+\\b",
  tier_labels: { "1": "formal", "2": "unverified", "3": "informal" },
  // All tabs enabled until the resolved [ui.tabs] map arrives.
  tabs: undefined,
};

const CorpusMetaContext = createContext<CorpusMeta>(FALLBACK);

/**
 * Fetches corpus branding (title, chat placeholder, starter questions) and the
 * record-id pattern once, from /api/corpus/meta, so no demo copy is compiled into
 * the app. Provides a generic fallback until it resolves.
 */
export function CorpusMetaProvider({ children }: { children: React.ReactNode }) {
  const [meta, setMeta] = useState<CorpusMeta>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    api
      .getCorpusMeta()
      .then((m) => !cancelled && setMeta(m))
      .catch(() => {
        /* keep the generic fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <CorpusMetaContext.Provider value={meta}>{children}</CorpusMetaContext.Provider>;
}

export function useCorpusMeta(): CorpusMeta {
  return useContext(CorpusMetaContext);
}
