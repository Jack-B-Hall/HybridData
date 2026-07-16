import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveApi } from "./client";
import { ApiError } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("liveApi", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getHealth GETs /api/health and returns the parsed body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok", llm_backend: "mock/mock", embedder: "hash", db: "data/hde.db" }));

    const result = await liveApi.getHealth();

    expect(mockFetch).toHaveBeenCalledWith("/api/health", expect.objectContaining({ headers: expect.any(Object) }));
    expect(result.status).toBe("ok");
  });

  it("ask POSTs the question as JSON to /api/ask", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        question: "Why?",
        answered: true,
        verdict: "sufficient",
        confidence: "high",
        answer: "Because. [1]",
        signals: {
          id_anchor: false,
          term_coverage: 1,
          top_score: 0.03,
          n_strong: 1,
          n_chunks: 1,
          n_terms: 1,
          question_ids: [],
          named_known: [],
          named_retrieved: [],
        },
        claims: [],
        citations: [],
        graph_paths: [],
        sources: [],
        latency_ms: 5,
        backend: "mock/mock",
        retrieval: { fts_hits: 0, vector_hits: 0, graph_hits: 0, anchors: [], fused_candidates: 0 },
      }),
    );

    const result = await liveApi.ask("Why?");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/ask",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ question: "Why?" }) }),
    );
    expect(result.answer).toBe("Because. [1]");
  });

  it("getDocuments serializes filter params into the query string", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, documents: [] }));

    await liveApi.getDocuments({ kind: "document", source: "PLM", query: "battery", limit: 50 });

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const url = new URL(calledUrl, "http://localhost");
    expect(url.pathname).toBe("/api/documents");
    expect(url.searchParams.get("kind")).toBe("document");
    expect(url.searchParams.get("source")).toBe("PLM");
    expect(url.searchParams.get("query")).toBe("battery");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("getDocuments omits undefined/empty params from the query string", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, documents: [] }));

    await liveApi.getDocuments({});

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("/api/documents");
  });

  it("getDocument encodes the id into the path", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await liveApi.getDocument("ECR-214");

    expect(mockFetch).toHaveBeenCalledWith("/api/documents/ECR-214", expect.any(Object));
  });

  it("throws ApiError with the status code on a non-OK response", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(jsonResponse({ detail: "Unknown document 'NOPE'" }, 404));

    await expect(liveApi.getDocument("NOPE")).rejects.toBeInstanceOf(ApiError);
    await expect(liveApi.getDocument("NOPE")).rejects.toMatchObject({ status: 404 });
  });

  it("submitFeedback POSTs the ask id, rating and comment", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, feedback_id: 7 }));

    const res = await liveApi.submitFeedback({ ask_id: 42, rating: "down", comment: "off" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ask_id: 42, rating: "down", comment: "off" }),
      }),
    );
    expect(res.feedback_id).toBe(7);
  });

  it("getTelemetryHealth requests the health endpoint with the recent limit", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        totals: { asks: 3, answered: 2, refused: 1, errors: 0, abandoned: 0 },
        answer_rate: 0.66,
        latency: { p50_ms: 1200, p95_ms: 1800 },
        feedback: { up: 1, down: 1, ratio: 0.5 },
        per_day: [],
        recent: [],
      }),
    );

    const health = await liveApi.getTelemetryHealth(10);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const url = new URL(calledUrl, "http://localhost");
    expect(url.pathname).toBe("/api/telemetry/health");
    expect(url.searchParams.get("recent")).toBe("10");
    expect(health.totals.asks).toBe(3);
  });

  it("getGraphNode passes hops through as a query param", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ center: "P-1062", nodes: [], edges: [] }));

    await liveApi.getGraphNode("P-1062", 2);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const url = new URL(calledUrl, "http://localhost");
    expect(url.pathname).toBe("/api/graph/node/P-1062");
    expect(url.searchParams.get("hops")).toBe("2");
  });

  it("getGoldenQuestions serializes filters, stringifying the enabled boolean", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, questions: [] }));

    await liveApi.getGoldenQuestions({ category: "lookup", behaviour: "refuse", enabled: false });

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const url = new URL(calledUrl, "http://localhost");
    expect(url.pathname).toBe("/api/testing/questions");
    expect(url.searchParams.get("category")).toBe("lookup");
    expect(url.searchParams.get("behaviour")).toBe("refuse");
    expect(url.searchParams.get("enabled")).toBe("false");
  });

  it("addGoldenQuestion POSTs the question body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 5 }));

    await liveApi.addGoldenQuestion({ text: "Q?", category: "custom", citations: ["ECR-1"] });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/testing/questions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateGoldenQuestion PATCHes the id path", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 5, enabled: false }));

    await liveApi.updateGoldenQuestion(5, { enabled: false });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/testing/questions/5",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    );
  });

  it("deleteGoldenQuestion DELETEs the id path", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true, deleted: 5 }));

    await liveApi.deleteGoldenQuestion(5);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/testing/questions/5",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("getTestingConfig GETs the scoring config endpoint", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({
      pass_threshold: 60, weights: { retrieval: 0.3, correctness: 0.4, groundedness: 0.2, completeness: 0.1 },
      rubric_dims: ["correctness"], judge: { backend: "mock", model: "mock", same_as_answer_model: true },
    }));
    const cfg = await liveApi.getTestingConfig();
    expect(mockFetch).toHaveBeenCalledWith("/api/testing/config", expect.any(Object));
    expect(cfg.weights.correctness).toBe(0.4);
  });

  it("addGoldenQuestion includes the golden_answer in the POST body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 6 }));
    await liveApi.addGoldenQuestion({ text: "Q?", golden_answer: "reference" });
    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.golden_answer).toBe("reference");
  });

  it("startTestRun POSTs categories and getTestRun encodes the run id", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ running: true }));
    await liveApi.startTestRun({ categories: ["impact"] });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/testing/run",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ categories: ["impact"] }) }),
    );

    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 9, results: [] }));
    await liveApi.getTestRun(9);
    expect(mockFetch).toHaveBeenLastCalledWith("/api/testing/runs/9", expect.any(Object));
  });
});
