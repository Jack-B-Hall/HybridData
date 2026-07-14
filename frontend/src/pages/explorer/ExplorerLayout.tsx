import { NavLink, Outlet } from "react-router-dom";

const TABS = [
  { to: "/explorer/graph", label: "Graph" },
  { to: "/explorer/table", label: "Documents" },
  { to: "/explorer/analytics", label: "Analytics" },
];

export function ExplorerLayout() {
  return (
    <div className="flex min-h-[calc(100vh-8.5rem)] flex-col">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight text-ink">Data Explorer</h1>
          <p className="mt-0.5 text-sm text-ink-muted">Browse the knowledge graph, the full corpus, and ingest analytics.</p>
        </div>
        <nav className="flex items-center gap-1 rounded-md border border-border bg-canvas-raised p-1" aria-label="Explorer views">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive ? "bg-accent text-canvas-raised" : "text-ink-muted hover:text-ink"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
