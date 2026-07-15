import { ApiError } from "./types";
import type {
  AskResult,
  AskStreamHandlers,
  DocumentDetail,
  DocumentListParams,
  DocumentListResponse,
  DocumentSummary,
  FeedbackRating,
  FeedbackRequest,
  TelemetryHealth,
} from "./types";
import type { HdeApi } from "./client";
import {
  corpusStats,
  documentDetail,
  documents,
  graphNode,
  graphOverview,
  health,
  ingestHistory,
  pickAskFixture,
} from "@/mocks/fixtures";

function filterDocuments(params: DocumentListParams): DocumentSummary[] {
  let list = documents.documents;
  if (params.kind) list = list.filter((d) => d.kind === params.kind);
  if (params.source) list = list.filter((d) => d.source === params.source);
  if (params.subsystem) list = list.filter((d) => d.subsystem === params.subsystem);
  if (params.query) {
    const q = params.query.toLowerCase();
    list = list.filter((d) => d.id.toLowerCase().includes(q) || d.title.toLowerCase().includes(q));
  }
  return list.slice(0, params.limit ?? 200);
}

/**
 * Only one full document body ships in the fixtures (document_detail.json,
 * for ECR-214). For any other id we synthesize a detail record from the
 * summary in documents.json rather than fabricating body text — the viewer
 * renders an honest "not available in mock mode" empty state for `text`.
 */
function buildDocumentDetail(id: string): DocumentDetail {
  if (id === documentDetail.id) return documentDetail;

  const summary = documents.documents.find((d) => d.id === id);
  if (!summary) {
    throw new ApiError(`Unknown document '${id}'`, 404);
  }
  return {
    id: summary.id,
    kind: summary.kind,
    title: summary.title,
    text: "",
    source: summary.source,
    prov_tier: summary.prov_tier,
    tier_label: summary.tier_label,
    subsystem: summary.subsystem,
    parent_id: null,
    metadata: {},
    sections: [],
    refs: [],
    referenced_by: [],
    closure: {
      artifact_id: summary.id,
      title: summary.title,
      prov_tier: summary.prov_tier,
      downstream_ids: [],
      upstream_ids: [],
      summary: "",
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tiny in-memory telemetry store so offline mode logs asks/feedback and the
// analytics "System health" view is populated without a backend.
interface MockAsk {
  id: number;
  ts: string;
  question: string;
  verdict: AskResult["verdict"];
  confidence: AskResult["confidence"];
  answered: boolean;
  latency_ms: number;
  status: "ok";
  streamed: boolean;
  feedback: FeedbackRating | null;
}
const mockAsks: MockAsk[] = [];
let mockAskSeq = 0;

function logMockAsk(result: AskResult, streamed: boolean): number {
  const id = ++mockAskSeq;
  mockAsks.unshift({
    id,
    ts: new Date().toISOString(),
    question: result.question,
    verdict: result.verdict,
    confidence: result.confidence,
    answered: result.answered,
    latency_ms: result.latency_ms,
    status: "ok",
    streamed,
    feedback: null,
  });
  return id;
}

export const mockApi: HdeApi = {
  getHealth: async () => {
    await delay(60);
    return health;
  },

  ask: async (question: string) => {
    await delay(220);
    const result = pickAskFixture(question);
    return { ...result, ask_id: logMockAsk(result, false) };
  },

  askStream: async (question: string, handlers: AskStreamHandlers, signal?: AbortSignal) => {
    // Replays the committed fixture as the same event sequence a live backend
    // emits, so staged loading + streaming render identically offline.
    const aborted = () => signal?.aborted ?? false;
    const base = pickAskFixture(question);
    const result: AskResult = { ...base, ask_id: logMockAsk(base, true) };

    await delay(260);
    if (aborted()) return;
    handlers.onRetrieval?.({
      type: "retrieval",
      answered: result.answered,
      verdict: result.verdict,
      confidence: result.confidence,
      signals: result.signals,
      backend: result.backend,
      sources: result.sources,
      graph_paths: result.graph_paths,
      retrieval: result.retrieval,
    });

    if (result.answered) {
      await delay(220);
      const words = result.answer.split(" ");
      for (let i = 0; i < words.length; i += 3) {
        if (aborted()) return;
        const piece = words.slice(i, i + 3).join(" ");
        handlers.onToken?.(i === 0 ? piece : " " + piece);
        await delay(45);
      }
    }

    if (aborted()) return;
    await delay(80);
    handlers.onDone?.(result);
  },

  getDocuments: async (params: DocumentListParams = {}) => {
    await delay(90);
    const filtered = filterDocuments(params);
    const result: DocumentListResponse = { count: filtered.length, documents: filtered };
    return result;
  },

  getDocument: async (id: string) => {
    await delay(90);
    return buildDocumentDetail(id);
  },

  getGraphOverview: async () => {
    await delay(140);
    return graphOverview;
  },

  getGraphNode: async (id: string) => {
    await delay(90);
    if (id === graphNode.center) return graphNode;
    // Fall back to a single-node neighbourhood built from the overview so
    // any node in the graph tab remains clickable in mock mode.
    const node = graphOverview.nodes.find((n) => n.id === id);
    if (!node) throw new ApiError(`Unknown node '${id}'`, 404);
    const edges = graphOverview.edges.filter((e) => e.src === id || e.dst === id);
    const neighborIds = new Set(edges.flatMap((e) => [e.src, e.dst]));
    const nodes = graphOverview.nodes.filter((n) => neighborIds.has(n.id));
    return { center: id, nodes, edges };
  },

  getCorpusStats: async () => {
    await delay(90);
    return corpusStats;
  },

  getIngestHistory: async () => {
    await delay(60);
    return ingestHistory;
  },

  submitFeedback: async (body: FeedbackRequest) => {
    await delay(80);
    const ask = mockAsks.find((a) => a.id === body.ask_id);
    if (!ask) throw new ApiError(`no ask ${body.ask_id}`, 404);
    ask.feedback = body.rating;
    return { ok: true, feedback_id: body.ask_id };
  },

  getTelemetryHealth: async () => {
    await delay(90);
    const ok = mockAsks.filter((a) => a.status === "ok");
    const answered = ok.filter((a) => a.answered).length;
    const refused = ok.filter((a) => !a.answered).length;
    const latencies = ok.map((a) => a.latency_ms).sort((x, y) => x - y);
    const pct = (p: number) =>
      latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))]! : 0;
    const up = mockAsks.filter((a) => a.feedback === "up").length;
    const down = mockAsks.filter((a) => a.feedback === "down").length;
    const perDayMap = new Map<string, number>();
    for (const a of mockAsks) {
      const day = a.ts.slice(0, 10);
      perDayMap.set(day, (perDayMap.get(day) ?? 0) + 1);
    }
    const health: TelemetryHealth = {
      totals: { asks: mockAsks.length, answered, refused, errors: 0, abandoned: 0 },
      answer_rate: answered + refused ? answered / (answered + refused) : 0,
      latency: { p50_ms: pct(0.5), p95_ms: pct(0.95) },
      feedback: { up, down, ratio: up + down ? up / (up + down) : 0 },
      per_day: [...perDayMap.entries()].map(([day, count]) => ({ day, count })),
      recent: mockAsks.slice(0, 25).map((a) => ({
        id: a.id,
        ts: a.ts,
        question: a.question,
        verdict: a.verdict,
        confidence: a.confidence,
        answered: a.answered,
        latency_ms: a.latency_ms,
        status: a.status,
        streamed: a.streamed,
        feedback: a.feedback,
      })),
    };
    return health;
  },
};
