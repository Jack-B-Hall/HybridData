import { ApiError } from "./types";
import type {
  AskResult,
  AskStreamHandlers,
  ChatStreamHandlers,
  ChatTurn,
  ConversationDetail,
  ConversationsResponse,
  ConversationSummary,
  CorpusMeta,
  CorpusStatsResponse,
  IngestJobsResponse,
  IngestStartRequest,
  IngestStatus,
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
  GoldenQuestion,
  GoldenQuestionFilters,
  GoldenQuestionInput,
  GoldenQuestionsResponse,
  TestingConfig,
  TestRunDetail,
  TestRunRequest,
  TestRunStatus,
  TestRunsResponse,
} from "./types";
import { consumeChatSseStream, consumeSseStream } from "@/lib/sse";

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

  // ── Multi-turn chat conversations ─────────────────────────────────────────
  createConversation: (title?: string) =>
    request<ConversationSummary>("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),

  getConversations: () => request<ConversationsResponse>("/api/chat/conversations"),

  getConversation: (id: number) => request<ConversationDetail>(`/api/chat/conversations/${id}`),

  renameConversation: (id: number, title: string) =>
    request<ConversationDetail>(`/api/chat/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteConversation: (id: number) =>
    request<{ ok: boolean; deleted: number }>(`/api/chat/conversations/${id}`, {
      method: "DELETE",
    }),

  sendChatMessage: (id: number, message: string) =>
    request<ChatTurn>(`/api/chat/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  chatMessageStream: async (
    id: number,
    message: string,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
  ) => {
    let res: Response;
    try {
      res = await fetch(`/api/chat/conversations/${id}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
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
      await consumeChatSseStream(res.body, handlers);
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

  getCorpusMeta: () => request<CorpusMeta>("/api/corpus/meta"),

  startIngest: (body: IngestStartRequest) =>
    request<IngestStatus>("/api/ingest/start", { method: "POST", body: JSON.stringify(body) }),

  getIngestStatus: () => request<IngestStatus>("/api/ingest/status"),

  getIngestJobs: (limit?: number) =>
    request<IngestJobsResponse>(`/api/ingest/jobs${toQuery({ limit })}`),

  getCorpusStats: () => request<CorpusStatsResponse>("/api/corpus/stats"),

  getIngestHistory: () => request<IngestHistoryResponse>("/api/ingest/history"),

  submitFeedback: (body: FeedbackRequest) =>
    request<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getTelemetryHealth: (recent?: number) =>
    request<TelemetryHealth>(`/api/telemetry/health${toQuery({ recent })}`),

  getGoldenQuestions: (filters: GoldenQuestionFilters = {}) =>
    request<GoldenQuestionsResponse>(
      `/api/testing/questions${toQuery({
        category: filters.category,
        behaviour: filters.behaviour,
        enabled: filters.enabled === undefined ? undefined : String(filters.enabled),
      })}`,
    ),

  addGoldenQuestion: (body: GoldenQuestionInput) =>
    request<GoldenQuestion>("/api/testing/questions", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateGoldenQuestion: (id: number, body: Partial<GoldenQuestionInput>) =>
    request<GoldenQuestion>(`/api/testing/questions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteGoldenQuestion: (id: number) =>
    request<{ ok: boolean; deleted: number }>(`/api/testing/questions/${id}`, {
      method: "DELETE",
    }),

  getTestingConfig: () => request<TestingConfig>("/api/testing/config"),

  startTestRun: (body: TestRunRequest = {}) =>
    request<TestRunStatus>("/api/testing/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getTestRunStatus: () => request<TestRunStatus>("/api/testing/run/status"),

  getTestRuns: (limit?: number) =>
    request<TestRunsResponse>(`/api/testing/runs${toQuery({ limit })}`),

  getTestRun: (id: number) => request<TestRunDetail>(`/api/testing/runs/${id}`),
};

export type HdeApi = typeof liveApi;
