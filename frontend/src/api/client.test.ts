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

  it("getGraphNode passes hops through as a query param", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(jsonResponse({ center: "P-1062", nodes: [], edges: [] }));

    await liveApi.getGraphNode("P-1062", 2);

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const url = new URL(calledUrl, "http://localhost");
    expect(url.pathname).toBe("/api/graph/node/P-1062");
    expect(url.searchParams.get("hops")).toBe("2");
  });
});
