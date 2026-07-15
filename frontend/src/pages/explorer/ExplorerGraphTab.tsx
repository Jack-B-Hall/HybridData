import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { ArtifactKind, GraphEdge, GraphNode, GraphOverviewResponse, GraphNodeResponse } from "@/api/types";
import { NODE_KIND_COLOR, NODE_KIND_LABEL, tierFromProvTier } from "@/lib/graphColors";
import { TierBadge } from "@/components/TierBadge";
import { formatInt } from "@/lib/format";

type FGLink = { source: string | GraphNode; target: string | GraphNode; rel: string };

// react-force-graph augments node objects with layout coordinates at runtime.
type PositionedNode = GraphNode & { x?: number; y?: number };

const linkEndId = (end: string | GraphNode): string => (typeof end === "object" ? end.id : end);

export function ExplorerGraphTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const nodeParam = searchParams.get("node");
  const edgeParam = searchParams.get("edge"); // relationship focus: highlight nodeParam↔edgeParam

  const [overview, setOverview] = useState<GraphOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<ArtifactKind | "">("");
  const [subsystemFilter, setSubsystemFilter] = useState("");
  const [selected, setSelected] = useState<GraphNodeResponse | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [trail, setTrail] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, FGLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 560 });

  // Refs the (per-frame) canvas callbacks read, so highlight tracks the URL.
  const focusIdRef = useRef<string | null>(nodeParam);
  const pulseStartRef = useRef(0);
  const hoverIdRef = useRef<string | null>(null);
  focusIdRef.current = nodeParam;

  // Canvas can't resolve CSS variables, so read the theme colours once per render
  // (renders are infrequent) and hand the concrete values to the canvas drawers.
  const accentRef = useRef("#0891a8");
  const mutedRef = useRef("#6b6a62");
  const plateRef = useRef("#ffffff");
  if (typeof window !== "undefined") {
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue("--color-accent").trim();
    const muted = cs.getPropertyValue("--color-ink-muted").trim();
    const plate = cs.getPropertyValue("--color-canvas-raised").trim();
    if (accent) accentRef.current = accent;
    if (muted) mutedRef.current = muted;
    if (plate) plateRef.current = plate;
  }

  useEffect(() => {
    // Fetch the whole graph (well under the API cap) so any node linked from an
    // answer or reached by a hop is present in the canvas and can be focused +
    // highlighted — a 400-node slice would leave many path targets unrendered.
    api.getGraphOverview(2000).then(setOverview).finally(() => setLoading(false));
  }, []);

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

  // Centre + zoom the camera on a node (if it is laid out) and start a pulse.
  const focusNodeById = useCallback((id: string): boolean => {
    const node = graphData.nodes.find((n) => n.id === id) as PositionedNode | undefined;
    if (!node || node.x == null || node.y == null || !fgRef.current) return false;
    fgRef.current.centerAt(node.x, node.y, 700);
    fgRef.current.zoom(3.2, 700);
    pulseStartRef.current = Date.now();
    return true;
  }, [graphData]);

  // Default framing: this dataset has outliers that wreck zoomToFit, so centre
  // on the core at a fixed zoom. Skip it when we're focusing a specific node.
  const fittedRef = useRef(false);
  useEffect(() => {
    fittedRef.current = false;
  }, [overview]);

  const settle = useCallback(() => {
    if (focusIdRef.current && focusNodeById(focusIdRef.current)) return;
    if (fittedRef.current) return;
    fittedRef.current = true;
    fgRef.current?.centerAt(0, 0, 0);
    fgRef.current?.zoom(2.4, 0);
  }, [focusNodeById]);

  useEffect(() => {
    if (!overview) return;
    const timer = setTimeout(settle, 350);
    return () => clearTimeout(timer);
  }, [overview, settle]);

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

  // Navigation is URL-driven: selecting a node just updates the query string.
  const selectNode = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("node", id);
          next.delete("edge");
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  // Fetch the selected node's neighborhood whenever the URL node/edge changes,
  // maintain the back-trail, and re-centre the camera on it.
  useEffect(() => {
    if (!nodeParam) {
      setSelected(null);
      return;
    }
    // Maintain the back-trail: a hop forward appends; navigating back to the
    // previous node pops. (No navigation happens here — this only tracks it.)
    setTrail((prev) => {
      if (prev[prev.length - 1] === nodeParam) return prev;
      if (prev.length >= 2 && prev[prev.length - 2] === nodeParam) return prev.slice(0, -1);
      return [...prev, nodeParam];
    });
    let cancelled = false;
    setSelectedLoading(true);
    api
      .getGraphNode(nodeParam, 1)
      .then((res) => {
        if (cancelled) return;
        setSelected(res);
        // Already laid out (a hop within a settled graph) → focus immediately.
        focusNodeById(nodeParam);
      })
      .catch(() => !cancelled && setSelected(null))
      .finally(() => !cancelled && setSelectedLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeParam, edgeParam]);

  const goBack = useCallback(() => {
    const target = trail[trail.length - 2];
    if (!target) return;
    // Navigate only; the selection effect trims the trail when it sees the pop.
    setSearchParams((sp) => {
      const n = new URLSearchParams(sp);
      n.set("node", target);
      n.delete("edge");
      return n;
    });
  }, [trail, setSearchParams]);

  const subsystems = useMemo(() => {
    if (!overview) return [];
    const set = new Set<string>();
    overview.nodes.forEach((n) => n.subsystem && set.add(n.subsystem));
    return [...set].sort();
  }, [overview]);

  // Which nodes/edge to highlight on the canvas.
  const highlightIds = useMemo(() => {
    const s = new Set<string>();
    if (nodeParam) s.add(nodeParam);
    if (edgeParam) s.add(edgeParam);
    return s;
  }, [nodeParam, edgeParam]);

  const isFocusedEdge = useCallback(
    (link: FGLink) => {
      if (!nodeParam || !edgeParam) return false;
      const a = linkEndId(link.source);
      const b = linkEndId(link.target);
      return (a === nodeParam && b === edgeParam) || (a === edgeParam && b === nodeParam);
    },
    [nodeParam, edgeParam],
  );

  // Label a relationship line only when it's in the focused/hovered neighborhood
  // — always-on labels for ~3k edges would be unreadable. Reads refs so the
  // per-frame callback stays cheap and current.
  const shouldLabelLink = useCallback((link: FGLink): boolean => {
    const a = linkEndId(link.source);
    const b = linkEndId(link.target);
    const focus = focusIdRef.current;
    const hover = hoverIdRef.current;
    if (focus && (a === focus || b === focus)) return true;
    if (hover && (a === hover || b === hover)) return true;
    return false;
  }, []);

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
              linkColor={(l) => (isFocusedEdge(l) ? "var(--color-accent)" : "var(--color-border-strong)")}
              linkWidth={(l) => (isFocusedEdge(l) ? 2.5 : 0.6)}
              linkDirectionalArrowLength={(l) => (isFocusedEdge(l) ? 5 : 3)}
              linkDirectionalArrowRelPos={1}
              backgroundColor="rgba(0,0,0,0)"
              warmupTicks={150}
              cooldownTicks={100}
              d3VelocityDecay={0.3}
              onEngineStop={settle}
              onNodeClick={(n) => selectNode(n.id)}
              onNodeHover={(n) => {
                hoverIdRef.current = n?.id ?? null;
              }}
              nodeCanvasObjectMode={(n) => (highlightIds.has(n.id) ? "before" : "after")}
              nodeCanvasObject={(n, ctx, scale) => {
                if (highlightIds.has(n.id)) {
                  drawHighlightRing(n, ctx, n.id === focusIdRef.current, pulseStartRef.current, accentRef.current);
                  return;
                }
                if (scale < 2.4) return;
                const label = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label;
                ctx.font = "3px Manrope, sans-serif";
                ctx.fillStyle = mutedRef.current;
                ctx.textAlign = "center";
                ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + 6);
              }}
              linkCanvasObjectMode={() => "after"}
              linkCanvasObject={(l, ctx) => {
                if (shouldLabelLink(l)) {
                  drawLinkLabel(l, ctx, mutedRef.current, plateRef.current);
                }
              }}
            />
          )}
        </div>
      </div>

      <NodePanel
        selected={selected}
        loading={selectedLoading}
        onSelect={selectNode}
        edgeTarget={edgeParam}
        canGoBack={trail.length > 1}
        onBack={goBack}
      />
    </div>
  );
}

/** A glowing accent ring around a highlighted node; pulses briefly after focus. */
function drawHighlightRing(
  n: PositionedNode,
  ctx: CanvasRenderingContext2D,
  isCenter: boolean,
  pulseStart: number,
  accent: string,
) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const base = 7;
  const elapsed = Date.now() - pulseStart;
  const pulse = isCenter && elapsed < 1200 ? Math.abs(Math.sin(elapsed / 190)) * 3 : 0;
  const r = base + pulse;
  ctx.save();
  // Soft outer glow.
  ctx.globalAlpha = 0.16;
  ctx.beginPath();
  ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
  ctx.fillStyle = accent;
  ctx.fill();
  // Ring.
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.strokeStyle = accent;
  ctx.lineWidth = isCenter ? 1.6 : 1.1;
  ctx.stroke();
  ctx.restore();
}

/** Draw a relationship's type as muted text on a small plate at the link midpoint. */
function drawLinkLabel(l: FGLink, ctx: CanvasRenderingContext2D, color: string, plate: string) {
  const s = l.source;
  const t = l.target;
  if (typeof s !== "object" || typeof t !== "object") return;
  const sx = (s as PositionedNode).x;
  const sy = (s as PositionedNode).y;
  const tx = (t as PositionedNode).x;
  const ty = (t as PositionedNode).y;
  if (sx == null || sy == null || tx == null || ty == null) return;

  const x = (sx + tx) / 2;
  const y = (sy + ty) / 2;
  // Keep text roughly upright regardless of edge direction.
  let angle = Math.atan2(ty - sy, tx - sx);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.font = "2.5px Manrope, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = l.rel;
  const w = ctx.measureText(text).width;
  // Legibility plate over the crossing lines.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = plate;
  ctx.fillRect(-w / 2 - 0.6, -1.7, w + 1.2, 3.4);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-muted" data-testid="graph-legend">
      {(Object.keys(NODE_KIND_COLOR) as ArtifactKind[]).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: NODE_KIND_COLOR[kind] }} />
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
  edgeTarget,
  canGoBack,
  onBack,
}: {
  selected: GraphNodeResponse | null;
  loading: boolean;
  onSelect: (id: string) => void;
  edgeTarget: string | null;
  canGoBack: boolean;
  onBack: () => void;
}) {
  if (loading && !selected) {
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
        <p className="text-sm text-ink-muted">
          Click a node — or a graph path in an answer — to focus it here and inspect its typed relationships.
        </p>
      </div>
    );
  }

  const center = selected.nodes.find((n) => n.id === selected.center);
  const documentNeighbors = selected.nodes.filter((n) => n.id !== selected.center && n.kind === "document");
  const nodeById = new Map(selected.nodes.map((n) => [n.id, n]));
  const edgeToTarget = edgeTarget
    ? selected.edges.find((e) => e.src === edgeTarget || e.dst === edgeTarget)
    : undefined;

  return (
    <div className="space-y-4 rounded-card border border-border bg-canvas-raised p-4 shadow-panel" data-testid="graph-node-panel">
      <div>
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            data-testid="graph-back"
            className="mb-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-faint transition-colors hover:bg-canvas-sunken hover:text-ink"
          >
            <span aria-hidden>←</span> Back
          </button>
        )}
        <div className="font-mono text-[11px] text-ink-faint">{selected.center}</div>
        <h3 className="mt-0.5 font-display text-lg font-medium text-ink" data-testid="graph-node-title">
          {center?.label ?? selected.center}
        </h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {center && <TierBadge tier={tierFromProvTier(center.prov_tier)} />}
          {center?.subsystem && (
            <span className="rounded-full border border-border bg-canvas-sunken px-2 py-0.5 text-[11px] text-ink-muted">
              {center.subsystem}
            </span>
          )}
        </div>
      </div>

      {edgeToTarget && (
        <div
          className="rounded-md border border-accent/30 bg-accent-soft/50 px-3 py-2 text-[12px]"
          data-testid="graph-focused-relationship"
        >
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-ink">
            Relationship
          </div>
          <div className="font-mono text-ink">
            {edgeToTarget.src} <span className="text-accent">{edgeToTarget.rel}</span> {edgeToTarget.dst}
          </div>
        </div>
      )}

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
            <RelationshipRow
              key={i}
              edge={edge}
              onSelect={onSelect}
              nodeById={nodeById}
              center={selected.center}
              edgeTarget={edgeTarget}
            />
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
  edgeTarget,
}: {
  edge: GraphEdge;
  onSelect: (id: string) => void;
  nodeById: Map<string, GraphNode>;
  center: string;
  edgeTarget: string | null;
}) {
  const other = edge.src === center ? edge.dst : edge.src;
  const otherLabel = nodeById.get(other)?.label ?? other;
  const emphasised = edgeTarget != null && other === edgeTarget;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(other)}
        data-testid="graph-relationship-row"
        className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left transition-colors hover:bg-canvas-sunken hover:text-accent-ink ${
          emphasised ? "bg-accent-soft/60 text-accent-ink ring-1 ring-inset ring-accent/30" : "text-ink-muted"
        }`}
        title={otherLabel}
      >
        <span className="text-accent">{edge.rel}</span>
        <span aria-hidden>→</span>
        <span className="truncate">{otherLabel}</span>
      </button>
    </li>
  );
}
