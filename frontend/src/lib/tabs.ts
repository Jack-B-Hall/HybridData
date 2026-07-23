// Per-tab enablement ([ui.tabs] config, served via /api/corpus/meta). A missing
// map or key means "enabled", so older backends and partial configs stay whole.

export type TabKey = "interface" | "chat" | "documents" | "explorer" | "ingestion" | "testing";

/** Nav order; `path` is where each tab's routes live. */
export const TABS: { key: TabKey; path: string; label: string; end: boolean }[] = [
  { key: "interface", path: "/", label: "Interface", end: true },
  { key: "chat", path: "/chat", label: "Chat", end: false },
  { key: "documents", path: "/documents", label: "Documents", end: false },
  { key: "explorer", path: "/explorer", label: "Data Explorer", end: false },
  { key: "ingestion", path: "/ingestion", label: "Ingestion", end: false },
  { key: "testing", path: "/testing", label: "Testing", end: false },
];

export function isTabEnabled(tabs: Record<string, boolean> | undefined, key: TabKey): boolean {
  return tabs?.[key] !== false;
}

/**
 * Where a deep link to a disabled tab should land: the first enabled tab in nav
 * order. With every tab disabled (a config mistake) fall back to the Interface
 * path rather than rendering nothing.
 */
export function firstEnabledPath(tabs: Record<string, boolean> | undefined): string {
  const first = TABS.find((tab) => isTabEnabled(tabs, tab.key));
  return first ? first.path : "/";
}
