import { NavLink, Outlet } from "react-router-dom";
import { useTheme } from "@/hooks/useTheme";
import { useMocks } from "@/api";

const NAV_ITEMS = [
  { to: "/", label: "Chat", end: true },
  { to: "/documents", label: "Documents", end: false },
  { to: "/explorer", label: "Data Explorer", end: false },
];

export function AppShell() {
  const { theme, toggle } = useTheme();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-5">
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="font-display text-[17px] font-medium tracking-tight text-ink">
              Hybrid-Data-Example
            </span>
            {useMocks && (
              <span className="rounded-full border border-tier-unverified/30 bg-tier-unverified-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-tier-unverified">
                Mock data
              </span>
            )}
          </div>

          <nav className="flex items-center gap-1" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-canvas-raised text-ink shadow-panel"
                      : "text-ink-muted hover:bg-canvas-raised/60 hover:text-ink"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              data-testid="theme-toggle"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-5 py-6">
        <Outlet />
      </main>
    </div>
  );
}

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="2.6" fill="var(--color-accent)" />
      <circle cx="18" cy="6" r="2.6" fill="var(--color-tier-informal)" />
      <circle cx="12" cy="18" r="2.6" fill="var(--color-tier-formal)" />
      <path
        d="M6 8.6V13a2 2 0 0 0 1 1.73l3.5 2.02M18 8.6V13a2 2 0 0 1-1 1.73l-3.5 2.02M8.2 5.2h7.6"
        stroke="var(--color-ink-faint)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 9.7A5.6 5.6 0 1 1 6.3 2.5a4.6 4.6 0 0 0 7.2 7.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
