export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatScore(value: number): string {
  return value.toFixed(4);
}

const integerFormatter = new Intl.NumberFormat("en-US");

export function formatInt(value: number): string {
  return integerFormatter.format(value);
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A human-friendly answer-model name from a backend id like
 * `ollama/gemma4:26b-a4b-it-qat` → "gemma4 26B", or `mock/mock` → "offline model".
 */
export function modelLabel(backend: string): string {
  if (!backend) return "the model";
  const slash = backend.indexOf("/");
  const provider = slash === -1 ? "" : backend.slice(0, slash);
  const model = slash === -1 ? backend : backend.slice(slash + 1);
  if (provider === "mock" || model === "mock") return "offline model";
  const base = model.split(":")[0] || model;
  const sizeMatch = /(\d+(?:\.\d+)?)b\b/i.exec(model);
  const size = sizeMatch ? ` ${sizeMatch[1] ?? ""}B` : "";
  return `${base}${size}`;
}
