import { formatInt } from "@/lib/format";

export interface BarListProps {
  data: Record<string, number>;
  color?: string;
  limit?: number;
}

/** Hand-rolled horizontal bar list — sorted descending, proportional to the max value. */
export function BarList({ data, color = "var(--color-accent)", limit }: BarListProps) {
  const entries = Object.entries(data)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const shown = limit ? entries.slice(0, limit) : entries;
  const max = Math.max(1, ...entries.map(([, v]) => v));

  if (entries.length === 0) {
    return <p className="text-sm text-ink-faint">No data.</p>;
  }

  return (
    <ul className="space-y-2">
      {shown.map(([label, value]) => (
        <li key={label} className="text-sm">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate text-ink-muted" title={label}>
              {label}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">{formatInt(value)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas-sunken">
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${(value / max) * 100}%`, backgroundColor: color }}
            />
          </div>
        </li>
      ))}
      {limit && entries.length > limit && (
        <li className="text-[11px] text-ink-faint">+{entries.length - limit} more</li>
      )}
    </ul>
  );
}
