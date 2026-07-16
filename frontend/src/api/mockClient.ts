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
  GraphNode,
  GraphNodeResponse,
  IngestJob,
  IngestStartRequest,
  IngestStatus,
  TelemetryHealth,
  GoldenQuestion,
  GoldenQuestionFilters,
  GoldenQuestionInput,
  TestRunDetail,
  TestRunRequest,
  TestRunStatus,
  TestRunSummary,
  TestResult,
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

// In-memory ingest job state so the Ingestion page works offline / in e2e.
const mockIngest: { status: IngestStatus; jobs: IngestJob[]; seq: number } = {
  status: {
    running: false,
    action: null,
    stage: "idle",
    started_at: null,
    finished_at: null,
    status: null,
    error: null,
    counts: {},
  },
  jobs: [],
  seq: 0,
};

function finishMockIngest(action: IngestStartRequest["action"]): void {
  const counts =
    action === "clear"
      ? { records: 0, chunks: 0, nodes: 0, edges: 0, added: 0, updated: 0, removed: 0 }
      : { records: 774, chunks: 795, nodes: 774, edges: 3143, added: 0, updated: 0, removed: 0 };
  const now = new Date().toISOString();
  mockIngest.status = {
    running: false,
    action,
    stage: "done",
    started_at: mockIngest.status.started_at,
    finished_at: now,
    status: "ok",
    error: null,
    counts,
  };
  mockIngest.jobs.unshift({
    id: ++mockIngest.seq,
    started_at: mockIngest.status.started_at ?? now,
    finished_at: now,
    action,
    source: "demo",
    status: "ok",
    n_records: counts.records,
    n_chunks: counts.chunks,
    n_nodes: counts.nodes,
    n_edges: counts.edges,
    n_added: counts.added,
    n_updated: counts.updated,
    n_removed: counts.removed,
    duration_ms: 900,
    error: null,
  });
}

/**
 * Build a node's neighbourhood from the union of the (capped) overview and the
 * richer graph_node fixture, so following relationships hop-by-hop resolves
 * offline even for ids the overview omits. Returns null for a truly unknown id.
 */
function buildMockNeighborhood(id: string): GraphNodeResponse | null {
  const allEdges = [...graphNode.edges, ...graphOverview.edges];
  const index = new Map<string, GraphNode>();
  for (const n of [...graphNode.nodes, ...graphOverview.nodes]) {
    if (!index.has(n.id)) index.set(n.id, n);
  }
  const edges = allEdges.filter((e) => e.src === id || e.dst === id);
  if (edges.length === 0) {
    const self = index.get(id);
    return self ? { center: id, nodes: [self], edges: [] } : null;
  }
  const ids = new Set<string>([id]);
  edges.forEach((e) => {
    ids.add(e.src);
    ids.add(e.dst);
  });
  const nodes = [...ids].map(
    (nid) => index.get(nid) ?? { id: nid, kind: "document" as const, label: nid, subsystem: null, source: "", prov_tier: 1 },
  );
  return { center: id, nodes, edges };
}

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

// In-memory golden set + test-run state so the Testing page works offline / e2e.
function nowIso(): string {
  return new Date().toISOString();
}

const mockGolden: { questions: GoldenQuestion[]; seq: number } = {
  questions: [
    {
      id: 1, text: "Why was the K-200 battery chemistry changed from LiPo to LiFePO4?",
      category: "provenance", behaviour: "answer", citations: ["KES-208", "WIKI-052", "ECR-214"],
      keywords: ["LiFePO4"],
      golden_answer:
        "The chemistry changed to LiFePO4 after the LiPo thermal runaway event KES-208 and to meet IEC 62133-2 for maritime BVLOS operations; approved via ECR-214 / ECN-312.",
      enabled: true, notes: "Seeded from the bundled demo gold set.",
      created_at: nowIso(), updated_at: nowIso(),
    },
    {
      id: 2, text: "If ECR-221 changes the propulsion motors, what parts and documents are affected?",
      category: "impact", behaviour: "answer", citations: ["ECR-221"], keywords: [],
      golden_answer:
        "ECR-221 replaces motors P-1031/P-1032 with P-1041/P-1042, impacting the ESCs, the GNC attitude tuning, and the propulsion ICD.",
      enabled: true, notes: "Seeded from the bundled demo gold set.",
      created_at: nowIso(), updated_at: nowIso(),
    },
    {
      id: 3, text: "What firmware version is currently installed on the encryption FPGA module?",
      category: "negative", behaviour: "refuse", citations: [], keywords: [],
      golden_answer: null,
      enabled: true, notes: "Out of scope — expect a refusal.",
      created_at: nowIso(), updated_at: nowIso(),
    },
  ],
  seq: 3,
};

const mockTestRun: {
  status: TestRunStatus;
  runs: TestRunSummary[];
  details: Map<number, TestRunDetail>;
  seq: number;
} = {
  status: {
    running: false, stage: "idle", started_at: null, finished_at: null,
    status: null, error: null, total: 0, done: 0, passed: 0, failed: 0, run_id: null,
  },
  runs: [],
  details: new Map(),
  seq: 0,
};

const MOCK_WEIGHTS = { retrieval: 0.3, correctness: 0.4, groundedness: 0.2, completeness: 0.1 };

function finishMockTestRun(questions: GoldenQuestion[]): void {
  const now = nowIso();
  const results: TestResult[] = questions.map((q, i) => {
    const answered = q.behaviour === "answer";
    const retrieval = 1.0;
    const judged = answered && !!q.golden_answer;
    // Plausible, deterministic rubric scores for the demo (a real judge varies).
    const dims = judged
      ? { correctness: 0.86, groundedness: 0.91, completeness: 0.8, citation_quality: 0.9 }
      : null;
    const composite = judged
      ? Math.round(
          100 *
            (MOCK_WEIGHTS.retrieval * retrieval +
              MOCK_WEIGHTS.correctness * dims!.correctness +
              MOCK_WEIGHTS.groundedness * dims!.groundedness +
              MOCK_WEIGHTS.completeness * dims!.completeness) *
            10,
        ) / 10
      : 100 * retrieval;
    return {
      id: i + 1, question_id: q.id, question: q.text, category: q.category,
      behaviour: q.behaviour, answered, verdict: answered ? "sufficient" : "insufficient",
      passed: composite >= 60, failed_checks: [], retrieval_score: retrieval,
      judged, judge_correctness: dims?.correctness ?? null,
      judge_groundedness: dims?.groundedness ?? null,
      judge_completeness: dims?.completeness ?? null,
      judge_citation: dims?.citation_quality ?? null,
      judge_justification: judged
        ? "Matches the reference on the key facts; claims are supported by the retrieved evidence."
        : null,
      composite, latency_ms: 40 + i * 7, error: null,
    };
  });
  const passed = results.filter((r) => r.passed).length;
  const answerRes = results.filter((r) => r.behaviour === "answer");
  const refuseRes = results.filter((r) => r.behaviour === "refuse");
  const comps = results.map((r) => r.composite ?? 0);
  const runId = ++mockTestRun.seq;
  const summary: TestRunSummary = {
    id: runId, started_at: mockTestRun.status.started_at ?? now, finished_at: now,
    status: "ok", backend: "mock/mock",
    judge_backend: results.some((r) => r.judged) ? "mock/mock" : null,
    scope: "all enabled", total: results.length,
    passed, failed: results.length - passed,
    answer_rate: answerRes.length ? answerRes.filter((r) => r.answered).length / answerRes.length : null,
    refusal_rate: refuseRes.length ? refuseRes.filter((r) => r.answered === false).length / refuseRes.length : null,
    mean_composite: comps.length ? Math.round((comps.reduce((s, c) => s + c, 0) / comps.length) * 10) / 10 : null,
    mean_latency_ms: results.length ? Math.round(results.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / results.length) : null,
    duration_ms: 900, error: null,
  };
  mockTestRun.runs.unshift(summary);
  mockTestRun.details.set(runId, { ...summary, results });
  mockTestRun.status = {
    running: false, stage: "done", started_at: summary.started_at, finished_at: now,
    status: "ok", error: null, total: results.length, done: results.length,
    passed, failed: results.length - passed, run_id: runId,
  };
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
    // The overview fixture is capped, so build a neighbourhood from the union of
    // the overview and the richer graph_node fixture. This lets hop-by-hop graph
    // walking (following relationships) resolve offline, not just overview nodes.
    if (id === graphNode.center) return graphNode;
    const built = buildMockNeighborhood(id);
    if (!built) throw new ApiError(`Unknown node '${id}'`, 404);
    return built;
  },

  getCorpusMeta: async () => {
    await delay(60);
    return {
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
    };
  },

  getCorpusStats: async () => {
    await delay(90);
    return corpusStats;
  },

  getIngestHistory: async () => {
    await delay(60);
    return ingestHistory;
  },

  startIngest: async (body: IngestStartRequest) => {
    await delay(120);
    if (body.action === "clear" && body.confirm !== "CLEAR") {
      throw new ApiError("clear requires the confirm token", 422);
    }
    if (mockIngest.status.running) throw new ApiError("an ingest job is already running", 409);
    mockIngest.status = {
      running: true,
      action: body.action,
      stage: "ingesting",
      started_at: new Date().toISOString(),
      finished_at: null,
      status: null,
      error: null,
      counts: {},
    };
    // Simulate a short job that then lands in history.
    window.setTimeout(() => finishMockIngest(body.action), 900);
    return mockIngest.status;
  },

  getIngestStatus: async () => {
    await delay(40);
    return mockIngest.status;
  },

  getIngestJobs: async () => {
    await delay(50);
    return { jobs: mockIngest.jobs.slice(0, 25) };
  },

  submitFeedback: async (body: FeedbackRequest) => {
    await delay(80);
    const ask = mockAsks.find((a) => a.id === body.ask_id);
    if (!ask) throw new ApiError(`no ask ${body.ask_id}`, 404);
    ask.feedback = body.rating;
    return { ok: true, feedback_id: body.ask_id };
  },

  getGoldenQuestions: async (filters: GoldenQuestionFilters = {}) => {
    await delay(60);
    let list = mockGolden.questions;
    if (filters.category) list = list.filter((q) => q.category === filters.category);
    if (filters.behaviour) list = list.filter((q) => q.behaviour === filters.behaviour);
    if (filters.enabled !== undefined) list = list.filter((q) => q.enabled === filters.enabled);
    return { count: list.length, questions: list };
  },

  addGoldenQuestion: async (body: GoldenQuestionInput) => {
    await delay(80);
    const now = nowIso();
    const q: GoldenQuestion = {
      id: ++mockGolden.seq, text: body.text, category: body.category ?? "general",
      behaviour: body.behaviour ?? "answer", citations: body.citations ?? [],
      keywords: body.keywords ?? [], golden_answer: body.golden_answer ?? null,
      enabled: body.enabled ?? true, notes: body.notes ?? null,
      created_at: now, updated_at: now,
    };
    mockGolden.questions.push(q);
    return q;
  },

  updateGoldenQuestion: async (id: number, body: Partial<GoldenQuestionInput>) => {
    await delay(80);
    const q = mockGolden.questions.find((x) => x.id === id);
    if (!q) throw new ApiError(`no golden question ${id}`, 404);
    Object.assign(q, body, { updated_at: nowIso() });
    return q;
  },

  deleteGoldenQuestion: async (id: number) => {
    await delay(80);
    const idx = mockGolden.questions.findIndex((x) => x.id === id);
    if (idx === -1) throw new ApiError(`no golden question ${id}`, 404);
    mockGolden.questions.splice(idx, 1);
    return { ok: true, deleted: id };
  },

  getTestingConfig: async () => {
    await delay(40);
    return {
      pass_threshold: 60.0,
      weights: MOCK_WEIGHTS,
      rubric_dims: ["correctness", "groundedness", "completeness", "citation_quality"],
      judge: { backend: "mock", model: "mock", same_as_answer_model: true },
    };
  },

  startTestRun: async (body: TestRunRequest = {}) => {
    await delay(120);
    if (mockTestRun.status.running) throw new ApiError("a test run is already in progress", 409);
    let questions = mockGolden.questions.filter((q) => q.enabled);
    if (body.categories?.length) {
      const wanted = new Set(body.categories);
      questions = questions.filter((q) => wanted.has(q.category));
    }
    mockTestRun.status = {
      running: true, stage: "asking 1/" + questions.length, started_at: nowIso(),
      finished_at: null, status: null, error: null, total: questions.length,
      done: 0, passed: 0, failed: 0, run_id: null,
    };
    window.setTimeout(() => finishMockTestRun(questions), 900);
    return mockTestRun.status;
  },

  getTestRunStatus: async () => {
    await delay(40);
    return mockTestRun.status;
  },

  getTestRuns: async () => {
    await delay(50);
    return { runs: mockTestRun.runs.slice(0, 25) };
  },

  getTestRun: async (id: number) => {
    await delay(50);
    const detail = mockTestRun.details.get(id);
    if (!detail) throw new ApiError(`no test run ${id}`, 404);
    return detail;
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
