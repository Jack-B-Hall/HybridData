import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { ArtifactKind, GraphEdge, GraphNode, GraphOverviewResponse, GraphNodeResponse } from "@/api/types";
import { NODE_KIND_COLOR, NODE_KIND_LABEL, tierFromProvTier } from "@/lib/graphColors";
import { TierBadge } from "@/components/TierBadge";
import { Link } from "react-router-dom";
import { formatInt } from "@/lib/format";

type FGLink = { source: string; target: string; rel: string };

export function ExplorerGraphTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [overview, setOverview] = useState<GraphOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<ArtifactKind | "">("");
  const [subsystemFilter, setSubsystemFilter] = useState("");
  const [selected, setSelected] = useState<GraphNodeResponse | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, FGLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 560 });

  useEffect(() => {
    api
      .getGraphOverview()
      .then(setOverview)
      .finally(() => setLoading(false));
  }, []);

  // This dataset is a dense core (~400 nodes, ~1,100 edges) with a handful
  // of loosely-connected outliers that drift far out under charge
  // repulsion. zoomToFit's bounding box includes those outliers, which
  // zooms the *whole* view out so far that the legible core shrinks to an
  // illegible speck. Center on the core and hold a fixed, comfortable zoom
  // instead of chasing the outliers. Guard against running twice (React
  // StrictMode double-invokes effects in dev).
  const fittedRef = useRef(false);
  useEffect(() => {
    fittedRef.current = false;
  }, [overview]);

  const fitOnce = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    fgRef.current?.centerAt(0, 0, 0);
    fgRef.current?.zoom(2.4, 0);
  }, []);

  // Fallback in case onEngineStop doesn't fire (e.g. cooldownTicks=0
  // resolving the cooldown loop before a listener can attach).
  useEffect(() => {
    if (!overview) return;
    const timer = setTimeout(fitOnce, 300);
    return () => clearTimeout(timer);
  }, [overview, fitOnce]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(320, width), height: Math.max(420, height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectNode = useCallback((id: string) => {
    setSelectedLoading(true);
    api
      .getGraphNode(id, 1)
      .then((res) => setSelected(res))
      .catch(() => setSelected(null))
      .finally(() => setSelectedLoading(false));
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("node", id);
      return next;
    });
  }, [setSearchParams]);

  useEffect(() => {
    const nodeParam = searchParams.get("node");
    if (nodeParam) selectNode(nodeParam);
    // Only run once on mount for deep-link support.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subsystems = useMemo(() => {
    if (!overview) return [];
    const set = new Set<string>();
    overview.nodes.forEach((n) => n.subsystem && set.add(n.subsystem));
    return [...set].sort();
  }, [overview]);

  const graphData = useMemo(() => {
    if (!overview) return { nodes: [] as GraphNode[], links: [] as FGLink[] };
    let nodes = overview.nodes as GraphNode[];
    if (kindFilter) nodes = nodes.filter((n) => n.kind === kindFilter);
    if (subsystemFilter) nodes = nodes.filter((n) => n.subsystem === subsystemFilter);
    const ids = new Set(nodes.map((n) => n.id));
    const links = overview.edges
      .filter((e) => ids.has(e.src) && ids.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, rel: e.rel }) as FGLink);
    return { nodes, links };
  }, [overview, kindFilter, subsystemFilter]);

  return (
    <div className="grid h-full min-h-[560px] grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr),320px]">
      <div className="flex min-h-0 flex-col rounded-card border border-border bg-canvas-raised shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
          <div className="flex flex-wrap gap-1.5">
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as ArtifactKind | "")}
              data-testid="graph-filter-kind"
              className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
            >
              <option value="">All kinds</option>
              <option value="document">Document</option>
              <option value="entity">Entity</option>
              <option value="person">Person</option>
            </select>
            <select
              value={subsystemFilter}
              onChange={(e) => setSubsystemFilter(e.target.value)}
              data-testid="graph-filter-subsystem"
              className="rounded-md border border-border bg-canvas px-2 py-1 text-xs text-ink-muted focus:border-accent/60 focus:outline-none"
            >
              <option value="">All subsystems</option>
              {subsystems.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <Legend />
        </div>

        <div ref={containerRef} className="relative min-h-0 flex-1" data-testid="graph-canvas">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-faint">
              Loading graph…
            </div>
          )}
          {!loading && overview && (
            <ForceGraph2D<GraphNode, FGLink>
              ref={fgRef}
              graphData={graphData}
              width={size.width}
              height={size.height}
              nodeId="id"
              nodeRelSize={4}
              nodeLabel={(n) => `${n.label}\n${n.id} · ${n.kind}`}
              nodeColor={(n) => NODE_KIND_COLOR[n.kind]}
              linkColor={() => "var(--color-border-strong)"}
              linkWidth={0.6}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              backgroundColor="rgba(0,0,0,0)"
              warmupTicks={150}
              cooldownTicks={100}
              d3VelocityDecay={0.3}
              onEngineStop={fitOnce}
              onNodeClick={(n) => selectNode(n.id)}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(n, ctx, scale) => {
                if (scale < 2.4) return;
                const label = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label;
                ctx.font = "3px Manrope, sans-serif";
                ctx.fillStyle = "var(--color-ink-muted)";
                ctx.textAlign = "center";
                ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + 6);
              }}
            />
          )}
        </div>
      </div>

      <NodePanel selected={selected} loading={selectedLoading} onSelect={selectNode} />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-muted" data-testid="graph-legend">
      {(Object.keys(NODE_KIND_COLOR) as ArtifactKind[]).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NODE_KIND_COLOR[kind] }}
          />
          {NODE_KIND_LABEL[kind]}
        </span>
      ))}
    </div>
  );
}

function NodePanel({
  selected,
  loading,
  onSelect,
}: {
  selected: GraphNodeResponse | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="rounded-card border border-border bg-canvas-raised p-4 shadow-panel">
        <div className="h-5 w-32 animate-pulse rounded bg-canvas-sunken" />
        <div className="mt-3 h-4 w-full animate-pulse rounded bg-canvas-sunken" />
      </div>
    );
  }

  if (!selected) {
    return (
      <div
        className="flex h-full min-h-[200px] flex-col items-center justify-center rounded-card border border-dashed border-border-strong bg-canvas-sunken/60 p-6 text-center"
        data-testid="graph-node-panel-empty"
      >
        <p className="text-sm text-ink-muted">Click a node to inspect its neighborhood and typed relationships.</p>
      </div>
    );
  }

  const center = selected.nodes.find((n) => n.id === selected.center);
  const documentNeighbors = selected.nodes.filter((n) => n.id !== selected.center && n.kind === "document");
  const nodeById = new Map(selected.nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-4 rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="graph-node-panel">
      <div>
        <div className="font-mono text-[11px] text-ink-faint">{selected.center}</div>
        <h3 className="mt-0.5 font-display text-lg font-medium text-ink">{center?.label ?? selected.center}</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {center && <TierBadge tier={tierFromProvTier(center.prov_tier)} />}
          {center?.subsystem && (
            <span className="rounded-full border border-border bg-canvas-sunken px-2 py-0.5 text-[11px] text-ink-muted">
              {center.subsystem}
            </span>
          )}
        </div>
      </div>

      {documentNeighbors.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Documents ({documentNeighbors.length})
          </h4>
          <ul className="space-y-1">
            {documentNeighbors.map((doc) => (
              <li key={doc.id}>
                <Link
                  to={`/documents/${encodeURIComponent(doc.id)}`}
                  className="block truncate rounded-md px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-canvas-sunken hover:text-accent-ink"
                  title={doc.label}
                >
                  {doc.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Relationships ({formatInt(selected.edges.length)})
        </h4>
        <ul className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
          {selected.edges.map((edge, i) => (
            <RelationshipRow key={i} edge={edge} onSelect={onSelect} nodeById={nodeById} center={selected.center} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function RelationshipRow({
  edge,
  onSelect,
  nodeById,
  center,
}: {
  edge: GraphEdge;
  onSelect: (id: string) => void;
  nodeById: Map<string, GraphNode>;
  center: string;
}) {
  const other = edge.src === center ? edge.dst : edge.src;
  const otherLabel = nodeById.get(other)?.label ?? other;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(other)}
        className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-ink-muted hover:bg-canvas-sunken hover:text-accent-ink"
        title={otherLabel}
      >
        <span className="text-accent">{edge.rel}</span>
        <span aria-hidden>→</span>
        <span className="truncate">{otherLabel}</span>
      </button>
    </li>
  );
}
