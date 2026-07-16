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

interface GoldenQ {
  id: number;
  text: string;
  category: string;
  behaviour: "answer" | "refuse";
  citations: string[];
  keywords: string[];
  golden_answer: string | null;
  enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
interface TestingState {
  questions: GoldenQ[];
  qSeq: number;
  running: boolean;
  startedAt: number;
  startedIso: string | null;
  ranQuestions: number;
  runs: Record<string, unknown>[];
  details: Record<number, Record<string, unknown>>;
  runSeq: number;
}
function seedGolden(): GoldenQ[] {
  const now = new Date().toISOString();
  return [
    { id: 1, text: "Why was the K-200 battery chemistry changed from LiPo to LiFePO4?", category: "provenance", behaviour: "answer", citations: ["ECR-214"], keywords: [], golden_answer: "It changed to LiFePO4 after the KES-208 thermal event.", enabled: true, notes: null, created_at: now, updated_at: now },
    { id: 2, text: "What firmware version is on the encryption FPGA module?", category: "negative", behaviour: "refuse", citations: [], keywords: [], golden_answer: null, enabled: true, notes: null, created_at: now, updated_at: now },
  ];
}
let testing: TestingState = {
  questions: seedGolden(), qSeq: 2, running: false, startedAt: 0, startedIso: null,
  ranQuestions: 0, runs: [], details: {}, runSeq: 0,
};

function resetTelemetry(): void {
  askSeq = 0;
  recordedAsks = [];
  ingest = { running: false, action: null, startedAt: 0, startedIso: null, jobs: [], seq: 0 };
  testing = {
    questions: seedGolden(), qSeq: 2, running: false, startedAt: 0, startedIso: null,
    ranQuestions: 0, runs: [], details: {}, runSeq: 0,
  };
}

// A running test run finishes ~400ms after start, so a poller sees running then done.
function testRunStatus(): Record<string, unknown> {
  if (testing.running && Date.now() - testing.startedAt > 400) {
    const now = new Date().toISOString();
    const runId = ++testing.runSeq;
    const enabled = testing.questions.filter((q) => q.enabled);
    const results = enabled.slice(0, testing.ranQuestions || enabled.length).map((q, i) => {
      const answered = q.behaviour === "answer";
      const judged = answered && !!q.golden_answer;
      const composite = judged ? 88.0 : 100.0;
      return {
        id: i + 1, question_id: q.id, question: q.text, category: q.category,
        behaviour: q.behaviour, answered,
        verdict: answered ? "sufficient" : "insufficient",
        passed: composite >= 60, failed_checks: [], retrieval_score: 1.0,
        judged, judge_correctness: judged ? 0.86 : null,
        judge_groundedness: judged ? 0.91 : null, judge_completeness: judged ? 0.8 : null,
        judge_citation: judged ? 0.9 : null,
        judge_justification: judged ? "Agrees with the reference; claims supported by evidence." : null,
        composite, latency_ms: 40 + i * 5, error: null,
      };
    });
    const total = results.length;
    const comps = results.map((r) => r.composite);
    const summary = {
      id: runId, started_at: testing.startedIso, finished_at: now, status: "ok",
      backend: "mock/mock", judge_backend: results.some((r) => r.judged) ? "mock/mock" : null,
      scope: "all enabled", total, passed: total, failed: 0,
      answer_rate: 1, refusal_rate: results.some((r) => r.behaviour === "refuse") ? 1 : null,
      mean_composite: comps.length ? Math.round((comps.reduce((s, c) => s + c, 0) / comps.length) * 10) / 10 : null,
      mean_latency_ms: 50, duration_ms: 420, error: null,
    };
    testing.runs.unshift(summary);
    testing.details[runId] = { ...summary, results };
    testing.running = false;
  }
  const total = testing.questions.filter((q) => q.enabled).length;
  return {
    running: testing.running,
    stage: testing.running ? `asking 1/${total}` : "done",
    started_at: testing.startedIso,
    finished_at: testing.running ? null : new Date().toISOString(),
    status: testing.running ? null : "ok",
    error: null,
    total,
    done: testing.running ? 0 : total,
    passed: testing.running ? 0 : total,
    failed: 0,
    run_id: testing.running ? null : testing.runSeq,
  };
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

    // ── Testing (golden set + runs) ──────────────────────────────────────────
    if (pathname === "/api/testing/questions" && request.method() === "GET") {
      const category = url.searchParams.get("category");
      const behaviour = url.searchParams.get("behaviour");
      const enabled = url.searchParams.get("enabled");
      let list = testing.questions;
      if (category) list = list.filter((q) => q.category === category);
      if (behaviour) list = list.filter((q) => q.behaviour === behaviour);
      if (enabled != null) list = list.filter((q) => String(q.enabled) === enabled);
      await route.fulfill({ json: { count: list.length, questions: list } });
      return;
    }

    if (pathname === "/api/testing/questions" && request.method() === "POST") {
      const body = request.postDataJSON() as Partial<GoldenQ>;
      const now = new Date().toISOString();
      const q: GoldenQ = {
        id: ++testing.qSeq, text: body.text ?? "", category: body.category ?? "general",
        behaviour: (body.behaviour as GoldenQ["behaviour"]) ?? "answer",
        citations: body.citations ?? [], keywords: body.keywords ?? [],
        golden_answer: body.golden_answer ?? null,
        enabled: body.enabled ?? true, notes: body.notes ?? null,
        created_at: now, updated_at: now,
      };
      testing.questions.push(q);
      await route.fulfill({ status: 201, json: q });
      return;
    }

    const qIdMatch = /^\/api\/testing\/questions\/(\d+)$/.exec(pathname);
    if (qIdMatch) {
      const id = Number(qIdMatch[1]);
      const q = testing.questions.find((x) => x.id === id);
      if (request.method() === "PATCH") {
        if (!q) {
          await route.fulfill({ status: 404, json: { detail: `no golden question ${id}` } });
          return;
        }
        Object.assign(q, request.postDataJSON(), { updated_at: new Date().toISOString() });
        await route.fulfill({ json: q });
        return;
      }
      if (request.method() === "DELETE") {
        const idx = testing.questions.findIndex((x) => x.id === id);
        if (idx === -1) {
          await route.fulfill({ status: 404, json: { detail: `no golden question ${id}` } });
          return;
        }
        testing.questions.splice(idx, 1);
        await route.fulfill({ json: { ok: true, deleted: id } });
        return;
      }
    }

    if (pathname === "/api/testing/config") {
      await route.fulfill({ json: {
        pass_threshold: 60.0,
        weights: { retrieval: 0.3, correctness: 0.4, groundedness: 0.2, completeness: 0.1 },
        rubric_dims: ["correctness", "groundedness", "completeness", "citation_quality"],
        judge: { backend: "mock", model: "mock", same_as_answer_model: true },
      } });
      return;
    }

    if (pathname === "/api/testing/run" && request.method() === "POST") {
      if (testing.running) {
        await route.fulfill({ status: 409, json: { detail: "a test run is already in progress" } });
        return;
      }
      const body = request.postDataJSON() as { categories?: string[] };
      let enabled = testing.questions.filter((q) => q.enabled);
      if (body.categories?.length) {
        const wanted = new Set(body.categories);
        enabled = enabled.filter((q) => wanted.has(q.category));
      }
      testing.running = true;
      testing.startedAt = Date.now();
      testing.startedIso = new Date().toISOString();
      testing.ranQuestions = enabled.length;
      await route.fulfill({ json: testRunStatus() });
      return;
    }

    if (pathname === "/api/testing/run/status") {
      await route.fulfill({ json: testRunStatus() });
      return;
    }

    if (pathname === "/api/testing/runs" && request.method() === "GET") {
      testRunStatus(); // advance a finished run into history if due
      await route.fulfill({ json: { runs: testing.runs.slice(0, 25) } });
      return;
    }

    const runIdMatch = /^\/api\/testing\/runs\/(\d+)$/.exec(pathname);
    if (runIdMatch) {
      const detail = testing.details[Number(runIdMatch[1])];
      if (!detail) {
        await route.fulfill({ status: 404, json: { detail: `no test run ${runIdMatch[1]}` } });
        return;
      }
      await route.fulfill({ json: detail });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: `No mock route for ${pathname}` } });
    },
  );
}
