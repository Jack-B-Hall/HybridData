import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type {
  AskResult,
  CorpusStatsResponse,
  DocumentDetail,
  DocumentListResponse,
  FeedbackRating,
  GraphNodeResponse,
  GraphOverviewResponse,
  HealthResponse,
  IngestHistoryResponse,
  TelemetryHealth,
} from "../../src/api/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../src/mocks/fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf-8")) as T;
}

export const fixtures = {
  askSufficient: loadFixture<AskResult>("ask_sufficient"),
  askImpact: loadFixture<AskResult>("ask_impact"),
  askRefusal: loadFixture<AskResult>("ask_refusal"),
  documents: loadFixture<DocumentListResponse>("documents"),
  documentDetail: loadFixture<DocumentDetail>("document_detail"),
  graphOverview: loadFixture<GraphOverviewResponse>("graph_overview"),
  graphNode: loadFixture<GraphNodeResponse>("graph_node"),
  corpusStats: loadFixture<CorpusStatsResponse>("corpus_stats"),
  ingestHistory: loadFixture<IngestHistoryResponse>("ingest_history"),
  health: loadFixture<HealthResponse>("health"),
};

/** Mirrors the mock client's question -> fixture heuristic (src/mocks/fixtures/index.ts). */
function pickAsk(question: string): AskResult {
  const q = question.trim().toLowerCase();
  if (q === fixtures.askSufficient.question.toLowerCase()) return fixtures.askSufficient;
  if (q === fixtures.askImpact.question.toLowerCase()) return fixtures.askImpact;
  if (q === fixtures.askRefusal.question.toLowerCase()) return fixtures.askRefusal;
  if (/lipo|lifepo4|battery chemistry/.test(q)) return fixtures.askSufficient;
  if (/ecr-221|propulsion motor/.test(q)) return fixtures.askImpact;
  return { ...fixtures.askRefusal, question };
}

// In-memory telemetry so the feedback round-trip and the analytics "System
// health" view work end-to-end in e2e without a backend. Reset per test.
interface RecordedAsk {
  id: number;
  question: string;
  verdict: AskResult["verdict"];
  confidence: AskResult["confidence"];
  answered: boolean;
  latency_ms: number;
  streamed: boolean;
  feedback: FeedbackRating | null;
}
let askSeq = 0;
let recordedAsks: RecordedAsk[] = [];

interface IngestState {
  running: boolean;
  action: string | null;
  startedAt: number;
  startedIso: string | null;
  jobs: Record<string, unknown>[];
  seq: number;
}
let ingest: IngestState = { running: false, action: null, startedAt: 0, startedIso: null, jobs: [], seq: 0 };

function resetTelemetry(): void {
  askSeq = 0;
  recordedAsks = [];
  ingest = { running: false, action: null, startedAt: 0, startedIso: null, jobs: [], seq: 0 };
}

// A running job finishes ~400ms after start, so a poller observes running then done.
function ingestStatus(): Record<string, unknown> {
  if (ingest.running && Date.now() - ingest.startedAt > 400) {
    const now = new Date().toISOString();
    ingest.jobs.unshift({
      id: ++ingest.seq,
      started_at: ingest.startedIso,
      finished_at: now,
      action: ingest.action,
      source: "demo",
      status: "ok",
      n_records: 774,
      n_chunks: 795,
      n_nodes: 774,
      n_edges: 3143,
      n_added: 0,
      n_updated: 0,
      n_removed: 0,
      duration_ms: 420,
      error: null,
    });
    ingest.running = false;
  }
  return {
    running: ingest.running,
    action: ingest.action,
    stage: ingest.running ? "ingesting" : "done",
    started_at: ingest.startedIso,
    finished_at: ingest.running ? null : new Date().toISOString(),
    status: ingest.running ? null : "ok",
    error: null,
    counts: ingest.running ? {} : { records: 774, chunks: 795, added: 0, updated: 0, removed: 0 },
  };
}

function recordAsk(result: AskResult, streamed: boolean): AskResult {
  const id = ++askSeq;
  recordedAsks.unshift({
    id,
    question: result.question,
    verdict: result.verdict,
    confidence: result.confidence,
    answered: result.answered,
    latency_ms: result.latency_ms,
    streamed,
    feedback: null,
  });
  return { ...result, ask_id: id };
}

function mockHealth(): TelemetryHealth {
  const answered = recordedAsks.filter((a) => a.answered).length;
  const refused = recordedAsks.length - answered;
  const up = recordedAsks.filter((a) => a.feedback === "up").length;
  const down = recordedAsks.filter((a) => a.feedback === "down").length;
  return {
    totals: { asks: recordedAsks.length, answered, refused, errors: 0, abandoned: 0 },
    answer_rate: recordedAsks.length ? answered / recordedAsks.length : 0,
    latency: { p50_ms: 1200, p95_ms: 1800 },
    feedback: { up, down, ratio: up + down ? up / (up + down) : 0 },
    per_day: [{ day: new Date().toISOString().slice(0, 10), count: recordedAsks.length }],
    recent: recordedAsks.slice(0, 25).map((a) => ({
      id: a.id,
      ts: new Date().toISOString(),
      question: a.question,
      verdict: a.verdict,
      confidence: a.confidence,
      answered: a.answered,
      latency_ms: a.latency_ms,
      status: "ok" as const,
      streamed: a.streamed,
      feedback: a.feedback,
    })),
  };
}

/** Build a Server-Sent Events body replaying a fixture as the live stream would. */
function askStreamBody(result: AskResult): string {
  const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const parts: string[] = [];
  parts.push(
    frame({
      type: "retrieval",
      answered: result.answered,
      verdict: result.verdict,
      confidence: result.confidence,
      signals: result.signals,
      backend: result.backend,
      sources: result.sources,
      graph_paths: result.graph_paths,
      retrieval: result.retrieval,
    }),
  );
  if (result.answered) {
    const words = result.answer.split(" ");
    for (let i = 0; i < words.length; i += 3) {
      const piece = words.slice(i, i + 3).join(" ");
      parts.push(frame({ type: "token", text: i === 0 ? piece : " " + piece }));
    }
  }
  parts.push(frame({ type: "done", result }));
  return parts.join("");
}

/**
 * Intercepts every `/api/**` request the app makes and answers from the
 * committed fixtures — no live backend is ever contacted during e2e runs.
 */
export async function mockApiRoutes(page: Page): Promise<void> {
  resetTelemetry();
  // A glob like "**/api/**" would also match Vite's dev-server module URL
  // for our own src/api/*.ts modules — match on the request pathname
  // starting with the real backend prefix instead.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const { pathname } = url;

    if (pathname === "/api/health") {
      await route.fulfill({ json: fixtures.health });
      return;
    }

    if (pathname === "/api/ask" && request.method() === "POST") {
      const body = request.postDataJSON() as { question: string };
      await route.fulfill({ json: recordAsk(pickAsk(body.question), false) });
      return;
    }

    if (pathname === "/api/ask/stream" && request.method() === "POST") {
      const body = request.postDataJSON() as { question: string };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: askStreamBody(recordAsk(pickAsk(body.question), true)),
      });
      return;
    }

    if (pathname === "/api/feedback" && request.method() === "POST") {
      const body = request.postDataJSON() as { ask_id: number; rating: FeedbackRating };
      const ask = recordedAsks.find((a) => a.id === body.ask_id);
      if (!ask) {
        await route.fulfill({ status: 404, json: { detail: `no ask ${body.ask_id}` } });
        return;
      }
      ask.feedback = body.rating;
      await route.fulfill({ json: { ok: true, feedback_id: body.ask_id } });
      return;
    }

    if (pathname === "/api/telemetry/health") {
      await route.fulfill({ json: mockHealth() });
      return;
    }

    const docIdMatch = /^\/api\/documents\/([^/]+)$/.exec(pathname);
    if (docIdMatch) {
      const id = decodeURIComponent(docIdMatch[1]!);
      if (id === fixtures.documentDetail.id) {
        await route.fulfill({ json: fixtures.documentDetail });
        return;
      }
      const summary = fixtures.documents.documents.find((d) => d.id === id);
      if (!summary) {
        await route.fulfill({ status: 404, json: { detail: `Unknown document '${id}'` } });
        return;
      }
      const synthesized: DocumentDetail = {
        ...summary,
        text: "",
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
      await route.fulfill({ json: synthesized });
      return;
    }

    if (pathname === "/api/documents") {
      await route.fulfill({ json: fixtures.documents });
      return;
    }

    if (pathname === "/api/graph/overview") {
      await route.fulfill({ json: fixtures.graphOverview });
      return;
    }

    const nodeIdMatch = /^\/api\/graph\/node\/([^/]+)$/.exec(pathname);
    if (nodeIdMatch) {
      const id = decodeURIComponent(nodeIdMatch[1]!);
      if (id === fixtures.graphNode.center) {
        await route.fulfill({ json: fixtures.graphNode });
        return;
      }
      // Union of overview + the richer graph_node fixture, so hop-by-hop graph
      // walking resolves offline even for ids the capped overview omits.
      const allEdges = [...fixtures.graphNode.edges, ...fixtures.graphOverview.edges];
      const index = new Map(
        [...fixtures.graphNode.nodes, ...fixtures.graphOverview.nodes].map((n) => [n.id, n]),
      );
      const edges = allEdges.filter((e) => e.src === id || e.dst === id);
      if (edges.length === 0 && !index.has(id)) {
        await route.fulfill({ status: 404, json: { detail: `Unknown node '${id}'` } });
        return;
      }
      const ids = new Set<string>([id]);
      edges.forEach((e) => {
        ids.add(e.src);
        ids.add(e.dst);
      });
      const nodes = [...ids].map(
        (nid) => index.get(nid) ?? { id: nid, kind: "document", label: nid, subsystem: null, source: "", prov_tier: 1 },
      );
      const response: GraphNodeResponse = { center: id, nodes, edges };
      await route.fulfill({ json: response });
      return;
    }

    if (pathname === "/api/corpus/meta") {
      await route.fulfill({
        json: {
          title: "K-200 programme",
          placeholder: "Ask about the K-200 programme — parts, changes, decisions, incidents…",
          starter_questions: [
            { text: "Why was the K-200 battery chemistry changed from LiPo to LiFePO4?", hint: "Change history" },
            {
              text: "If ECR-221 changes the propulsion motors, what parts and documents are affected?",
              hint: "Impact analysis",
            },
            { text: "What is the capital of France?", hint: "Off-corpus — demonstrates refusal" },
          ],
          app_name: "Hybrid-Data-Example",
          app_icon: null,
          id_pattern: "\\b[A-Z]{1,6}-\\d+\\b",
          tier_labels: { "1": "formal", "2": "unverified", "3": "informal" },
        },
      });
      return;
    }

    if (pathname === "/api/corpus/stats") {
      await route.fulfill({ json: fixtures.corpusStats });
      return;
    }

    if (pathname === "/api/ingest/start" && request.method() === "POST") {
      const body = request.postDataJSON() as { action: string; confirm?: string };
      if (body.action === "clear" && body.confirm !== "CLEAR") {
        await route.fulfill({ status: 422, json: { detail: "clear requires the confirm token" } });
        return;
      }
      if (ingest.running) {
        await route.fulfill({ status: 409, json: { detail: "an ingest job is already running" } });
        return;
      }
      ingest.running = true;
      ingest.action = body.action;
      ingest.startedAt = Date.now();
      ingest.startedIso = new Date().toISOString();
      await route.fulfill({ json: ingestStatus() });
      return;
    }

    if (pathname === "/api/ingest/status") {
      await route.fulfill({ json: ingestStatus() });
      return;
    }

    if (pathname === "/api/ingest/jobs") {
      ingestStatus(); // advance a finished job into history if due
      await route.fulfill({ json: { jobs: ingest.jobs.slice(0, 25) } });
      return;
    }

    if (pathname === "/api/ingest/history") {
      await route.fulfill({ json: fixtures.ingestHistory });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: `No mock route for ${pathname}` } });
    },
  );
}
