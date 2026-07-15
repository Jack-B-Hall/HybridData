import { ApiError } from "./types";
import type {
  AskResult,
  AskStreamHandlers,
  CorpusStatsResponse,
  DocumentDetail,
  DocumentListParams,
  DocumentListResponse,
  FeedbackRequest,
  FeedbackResponse,
  GraphNodeResponse,
  GraphOverviewResponse,
  HealthResponse,
  IngestHistoryResponse,
  TelemetryHealth,
} from "./types";
import { consumeSseStream } from "@/lib/sse";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // response wasn't JSON — fall back to statusText
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const liveApi = {
  getHealth: () => request<HealthResponse>("/api/health"),

  ask: (question: string) =>
    request<AskResult>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),

  askStream: async (question: string, handlers: AskStreamHandlers, signal?: AbortSignal) => {
    let res: Response;
    try {
      res = await fetch("/api/ask/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ question }),
        signal,
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      handlers.onError?.(err instanceof Error ? err.message : "Network error");
      return;
    }
    if (!res.ok || !res.body) {
      handlers.onError?.(`Stream failed (${res.status})`);
      return;
    }
    try {
      await consumeSseStream(res.body, handlers);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      handlers.onError?.(err instanceof Error ? err.message : "Stream interrupted");
    }
  },

  getDocuments: (params: DocumentListParams = {}) =>
    request<DocumentListResponse>(
      `/api/documents${toQuery({
        kind: params.kind,
        source: params.source,
        subsystem: params.subsystem,
        query: params.query,
        limit: params.limit,
      })}`,
    ),

  getDocument: (id: string) =>
    request<DocumentDetail>(`/api/documents/${encodeURIComponent(id)}`),

  getGraphOverview: (limit?: number) =>
    request<GraphOverviewResponse>(`/api/graph/overview${toQuery({ limit })}`),

  getGraphNode: (id: string, hops?: number) =>
    request<GraphNodeResponse>(`/api/graph/node/${encodeURIComponent(id)}${toQuery({ hops })}`),

  getCorpusStats: () => request<CorpusStatsResponse>("/api/corpus/stats"),

  getIngestHistory: () => request<IngestHistoryResponse>("/api/ingest/history"),

  submitFeedback: (body: FeedbackRequest) =>
    request<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getTelemetryHealth: (recent?: number) =>
    request<TelemetryHealth>(`/api/telemetry/health${toQuery({ recent })}`),
};

export type HdeApi = typeof liveApi;
