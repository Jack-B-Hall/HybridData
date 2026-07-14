import { Link } from "react-router-dom";
import { graphNodePath } from "@/lib/paths";

export function RefChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center overflow-hidden rounded-md border border-border bg-canvas-raised text-[12px] leading-none">
      <Link
        to={`/documents/${encodeURIComponent(id)}`}
        className="px-2 py-1.5 font-mono text-ink-muted transition-colors hover:bg-canvas-sunken hover:text-accent-ink"
        data-testid="ref-chip"
      >
        {id}
      </Link>
      <Link
        to={graphNodePath(id)}
        aria-label={`View ${id} in graph`}
        title="View in graph"
        className="border-l border-border px-1.5 py-1.5 text-ink-faint transition-colors hover:bg-canvas-sunken hover:text-accent-ink"
      >
        ◎
      </Link>
    </span>
  );
}
