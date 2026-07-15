import { Link } from "react-router-dom";
import { extractNodeId } from "@/lib/ids";
import { graphEdgePath, graphNodePath } from "@/lib/paths";

export interface GraphPathsListProps {
  paths: string[];
}

const PATH_RE = /^(.*?)\s(-[A-Z_]+->)\s(.*)$/;

/**
 * Renders `"A -REL-> B"` relationship strings. Each node segment and the
 * relationship link into the Data Explorer's graph view, focused and highlighted
 * on that node (or the edge's endpoints) — so the reader can walk from a cited
 * fact straight into the knowledge graph.
 */
export function GraphPathsList({ paths }: GraphPathsListProps) {
  if (paths.length === 0) return null;
  return (
    <div data-testid="graph-paths">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Graph paths <span className="font-mono normal-case text-ink-faint">({paths.length})</span>
      </h2>
      <ul className="space-y-1.5 font-mono text-[12px] leading-relaxed">
        {paths.map((path, i) => {
          const match = PATH_RE.exec(path);
          if (!match) {
            return (
              <li key={i} className="text-ink-muted">
                {path}
              </li>
            );
          }
          const [, from, rel, to] = match;
          const fromId = extractNodeId(from!);
          const toId = extractNodeId(to!);
          const relType = rel!.replace(/^-|->$/g, "");
          return (
            <li key={i} className="text-ink-muted" data-testid="graph-path">
              <NodeSegment text={from!} id={fromId} />{" "}
              {fromId && toId ? (
                <Link
                  to={graphEdgePath(fromId, toId)}
                  data-testid="graph-path-rel"
                  title={`Show the ${relType} relationship in the graph`}
                  className="rounded px-0.5 text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:bg-accent-soft hover:decoration-accent"
                >
                  {rel}
                </Link>
              ) : (
                <span className="text-accent">{rel}</span>
              )}{" "}
              <NodeSegment text={to!} id={toId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A path node: a link into the focused graph view when its id parses, else plain text. */
function NodeSegment({ text, id }: { text: string; id: string | null }) {
  if (!id) return <span className="text-ink">{text}</span>;
  return (
    <Link
      to={graphNodePath(id)}
      data-testid="graph-path-node"
      data-node-id={id}
      title={`Focus ${id} in the graph`}
      className="rounded px-0.5 text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:bg-accent-soft hover:text-accent-ink hover:decoration-accent"
    >
      {text}
    </Link>
  );
}
