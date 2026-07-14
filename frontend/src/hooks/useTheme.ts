import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark";

const STORAGE_KEY = "hde-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): ThemePreference | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

function applyTheme(theme: ThemePreference | null): void {
  const root = document.documentElement;
  if (theme) {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

/**
 * Theme state that respects `prefers-color-scheme` until the user makes an
 * explicit choice via the header toggle, after which the choice is
 * persisted and wins over the system setting.
 */
export function useTheme(): { theme: ThemePreference; toggle: () => void; isExplicit: boolean } {
  const [explicit, setExplicit] = useState<ThemePreference | null>(() => readStoredTheme());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    applyTheme(explicit);
  }, [explicit]);

  const toggle = useCallback(() => {
    setExplicit((prev) => {
      const current = prev ?? (systemDark ? "dark" : "light");
      const next: ThemePreference = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, [systemDark]);

  const theme = explicit ?? (systemDark ? "dark" : "light");
  return { theme, toggle, isExplicit: explicit !== null };
}
