import { useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useTheme } from "@/hooks/useTheme";
import { useMocks } from "@/api";
import { useCorpusMeta } from "@/store/corpusMeta";
import { TABS, isTabEnabled } from "@/lib/tabs";

export function AppShell() {
  const { theme, toggle } = useTheme();
  const { app_name, app_icon, tabs } = useCorpusMeta();
  useBranding(app_name, app_icon);
  // Tabs switched off via [ui.tabs] disappear from the nav (their routes
  // additionally redirect, see App.tsx).
  const navItems = TABS.filter((tab) => isTabEnabled(tabs, tab.key));

  return (
    <div className="flex min-h-screen flex-col">
      {/* Solid background: bg-canvas/85 compiled to nothing (the palette is
          plain CSS vars without <alpha-value>), leaving a transparent header
          that scrolled content bled through. */}
      <header className="sticky top-0 z-30 border-b border-border bg-canvas">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-5">
          <div className="flex items-center gap-2.5">
            <AppIcon icon={app_icon} />
            <span
              className="font-display text-[17px] font-medium tracking-tight text-ink"
              data-testid="app-name"
            >
              {app_name}
            </span>
            {useMocks && (
              <span className="rounded-full border border-tier-unverified/30 bg-tier-unverified-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-tier-unverified">
                Mock data
              </span>
            )}
          </div>

          <nav className="flex items-center gap-1" aria-label="Primary">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
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

/** True when app_icon is an image reference rather than an emoji/short glyph. */
function isImageIcon(icon: string): boolean {
  return /^https?:\/\//.test(icon) || icon.startsWith("/") || /\.(png|jpe?g|svg|gif|webp|ico)$/i.test(icon);
}

/** The header glyph: built-in mark (null), an image, or an emoji. */
function AppIcon({ icon }: { icon: string | null }) {
  if (!icon) return <Mark />;
  if (isImageIcon(icon)) {
    return <img src={icon} alt="" width={22} height={22} className="rounded" data-testid="app-icon-image" />;
  }
  return (
    <span aria-hidden className="text-[20px] leading-none" data-testid="app-icon-emoji">
      {icon}
    </span>
  );
}

/** Data URI favicon for an emoji; image icons use their own href; null keeps the built-in. */
function faviconHref(icon: string | null): string | null {
  if (!icon) return null;
  if (isImageIcon(icon)) return icon;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y=".9em" font-size="52">${icon}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** Reflect the configured app name/icon into the browser tab title + favicon. */
function useBranding(appName: string, appIcon: string | null): void {
  useEffect(() => {
    if (appName) document.title = appName;
  }, [appName]);

  useEffect(() => {
    const href = faviconHref(appIcon);
    if (!href) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.setAttribute("href", href);
  }, [appIcon]);
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
