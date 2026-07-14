export interface GraphPathsListProps {
  paths: string[];
}

const PATH_RE = /^(.*?)\s(-[A-Z_]+->)\s(.*)$/;

/** Renders `"A -REL-> B"` relationship strings with the relation styled distinctly. */
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
          return (
            <li key={i} className="text-ink-muted">
              <span className="text-ink">{from}</span>{" "}
              <span className="text-accent">{rel}</span> <span className="text-ink">{to}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
