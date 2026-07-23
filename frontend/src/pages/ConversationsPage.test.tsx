import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AskResult, ChatTurn, ChatStreamHandlers } from "@/api/types";
import { DrawerProvider } from "@/store/drawer";

const mocks = vi.hoisted(() => ({
  getConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  chatMessageStream: vi.fn(),
  submitFeedback: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks, useMocks: false }));

import { ConversationsPage } from "./ConversationsPage";

function makeResult(overrides: Partial<AskResult> = {}): AskResult {
  return {
    question: "q",
    answered: true,
    verdict: "sufficient",
    confidence: "high",
    answer: "The battery uses LiFePO4. [1]",
    signals: {
      id_anchor: true, term_coverage: 0.8, top_score: 0.9, n_strong: 3,
      n_chunks: 8, n_terms: 5, question_ids: [], named_known: [], named_retrieved: [],
    },
    claims: [],
    citations: [{
      marker: 1, artifact_id: "ECR-214", title: "Battery change", source: "PLM",
      tier_label: "formal", chunk_idx: 0, char_start: 0, char_end: 40,
      passage: "Battery chemistry changed to LiFePO4.", grounded: true,
    }],
    graph_paths: [],
    sources: [{
      rowid: 1, artifact_id: "ECR-214", source: "PLM", art_kind: "document",
      title: "Battery change", prov_tier: 1, tier_label: "formal", chunk_idx: 0,
      char_start: 0, char_end: 40, body: "Battery chemistry changed to LiFePO4.",
      score: 0.9, legs: ["fts"],
    }],
    latency_ms: 42,
    backend: "mock/mock",
    retrieval: { fts_hits: 1, vector_hits: 1, graph_hits: 0, anchors: [], fused_candidates: 2 },
    ask_id: 7,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  const result = makeResult();
  return {
    id: 1, conversation_id: 1, ts: "2026-07-23T00:00:00+00:00",
    message: "Why did the battery chemistry change?",
    rewritten: "Why did the battery chemistry change?",
    rewrite_method: "raw", ask_id: 7, answered: true, verdict: "sufficient",
    confidence: "high", answer: result.answer, cited_ids: ["ECR-214"],
    result, latency_ms: 42, backend: "mock/mock", status: "ok", error: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DrawerProvider>
        <ConversationsPage />
      </DrawerProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConversations.mockResolvedValue({
    conversations: [
      { id: 1, created_at: "", updated_at: "", title: "Battery thread", n_turns: 2 },
    ],
  });
  mocks.getConversation.mockResolvedValue({
    id: 1, created_at: "", updated_at: "", title: "Battery thread", n_turns: 2,
    turns: [
      makeTurn(),
      makeTurn({
        id: 2,
        message: "what does it depend on?",
        rewritten: "what does it depend on? (context: ECR-214)",
        rewrite_method: "mock",
      }),
    ],
  });
});

describe("ConversationsPage", () => {
  it("loads the sidebar and renders the persisted thread with the rewrite note", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(2));
    expect(screen.getByTestId("conversation-title")).toHaveTextContent("Battery thread");

    // The follow-up turn subtly shows what was actually searched.
    const notes = screen.getAllByTestId("rewrite-note");
    expect(notes).toHaveLength(1); // the raw first turn shows no note
    expect(notes[0]).toHaveTextContent("searched for:");
    expect(notes[0]).toHaveTextContent("(context: ECR-214)");

    // Citation chips render from the reused AnswerRenderer.
    expect(screen.getAllByTestId("answer-body")).toHaveLength(2);
  });

  it("collapses graph paths and sources behind independent toggles", async () => {
    mocks.getConversation.mockResolvedValue({
      id: 1, created_at: "", updated_at: "", title: "Battery thread", n_turns: 1,
      turns: [
        makeTurn({
          result: makeResult({ graph_paths: ["KES-208 -TRIGGERS-> ECR-214"] }),
        }),
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(1));

    // Both sections start collapsed behind their counts.
    const pathsToggle = screen.getByTestId("graph-paths-toggle");
    const sourcesToggle = screen.getByTestId("sources-toggle");
    expect(pathsToggle).toHaveTextContent("1 graph path");
    expect(screen.queryByTestId("graph-paths")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sources-panel")).not.toBeInTheDocument();

    // Opening graph paths leaves sources alone.
    fireEvent.click(pathsToggle);
    expect(screen.getByTestId("graph-paths")).toBeInTheDocument();
    expect(screen.queryByTestId("sources-panel")).not.toBeInTheDocument();

    // And vice versa: sources opens independently, paths can close again.
    fireEvent.click(sourcesToggle);
    expect(screen.getByTestId("sources-panel")).toBeInTheDocument();
    fireEvent.click(pathsToggle);
    expect(screen.queryByTestId("graph-paths")).not.toBeInTheDocument();
    expect(screen.getByTestId("sources-panel")).toBeInTheDocument();
  });

  it("streams a new message and lands the done turn", async () => {
    mocks.chatMessageStream.mockImplementation(
      async (_id: number, message: string, handlers: ChatStreamHandlers) => {
        handlers.onRewrite?.({
          type: "rewrite", conversation_id: 1, message,
          rewritten: `${message} (context: ECR-214)`, rewrite_method: "mock",
        });
        handlers.onToken?.("streamed ");
        handlers.onDone?.(
          makeTurn({ id: 3, message, rewritten: `${message} (context: ECR-214)`, rewrite_method: "mock" }),
        );
      },
    );

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(2));

    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "who approved it?" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));

    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(3));
    expect(mocks.chatMessageStream).toHaveBeenCalledWith(
      1, "who approved it?", expect.anything(), expect.anything(),
    );
    expect(screen.getAllByTestId("rewrite-note")).toHaveLength(2);
    expect(screen.getAllByTestId("chat-user-message")[2]).toHaveTextContent("who approved it?");
  });

  it("renders a per-turn refusal with the reused refusal panel", async () => {
    const refusal = makeResult({
      answered: false, verdict: "insufficient", confidence: "low",
      answer: "Not covered by the corpus.", citations: [],
    });
    mocks.getConversation.mockResolvedValue({
      id: 1, created_at: "", updated_at: "", title: "Battery thread", n_turns: 1,
      turns: [makeTurn({ answered: false, verdict: "insufficient", result: refusal })],
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId("refusal-panel")).toBeInTheDocument());
    expect(screen.getByText("Not in the corpus")).toBeInTheDocument();
  });

  it("shows a clean per-turn error without losing the thread", async () => {
    mocks.chatMessageStream.mockImplementation(
      async (_id: number, _m: string, handlers: ChatStreamHandlers) => {
        handlers.onError?.("chat turn failed: model host unreachable");
      },
    );

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(2));

    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "hello again friend" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));

    await waitFor(() => expect(screen.getByTestId("chat-turn-error")).toBeInTheDocument());
    expect(screen.getByTestId("chat-turn-error")).toHaveTextContent("model host unreachable");
    // Prior turns are still on screen.
    expect(screen.getAllByTestId("answer-body")).toHaveLength(2);
  });

  it("creates a conversation on first send when none exists", async () => {
    mocks.getConversations.mockResolvedValue({ conversations: [] });
    mocks.createConversation.mockResolvedValue({
      id: 9, created_at: "", updated_at: "", title: null, n_turns: 0,
    });
    mocks.chatMessageStream.mockImplementation(
      async (_id: number, message: string, handlers: ChatStreamHandlers) => {
        handlers.onDone?.(makeTurn({ id: 1, conversation_id: 9, message }));
      },
    );

    renderPage();
    await waitFor(() => expect(screen.getByText(/No conversations yet/)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "Why did the chemistry change?" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));

    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.chatMessageStream).toHaveBeenCalledWith(
        9, "Why did the chemistry change?", expect.anything(), expect.anything(),
      ),
    );
  });

  it("keeps the first streaming turn visible when the fresh conversation loads empty", async () => {
    // Real-backend timing: the turn is persisted only at `done`, so the refetch
    // triggered by selecting the just-created conversation returns zero turns
    // while the answer is still streaming. It must not wipe the in-flight turn.
    mocks.getConversations.mockResolvedValue({ conversations: [] });
    mocks.createConversation.mockResolvedValue({
      id: 9, created_at: "", updated_at: "", title: null, n_turns: 0,
    });
    mocks.getConversation.mockResolvedValue({
      id: 9, created_at: "", updated_at: "", title: null, n_turns: 0, turns: [],
    });
    let finish!: () => void;
    mocks.chatMessageStream.mockImplementation(
      (_id: number, message: string, handlers: ChatStreamHandlers) =>
        new Promise<void>((resolve) => {
          handlers.onToken?.("streaming ");
          finish = () => {
            handlers.onDone?.(makeTurn({ id: 1, conversation_id: 9, message }));
            resolve();
          };
        }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText(/No conversations yet/)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "Why did the chemistry change?" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));

    await waitFor(() => expect(mocks.getConversation).toHaveBeenCalledWith(9));
    await act(() => Promise.resolve()); // let the (empty) refetch commit
    expect(screen.getByTestId("chat-user-message")).toHaveTextContent("Why did the chemistry change?");
    expect(screen.getByTestId("chat-streaming-answer")).toBeInTheDocument();

    act(() => finish());
    await waitFor(() => expect(screen.getByTestId("answer-body")).toBeInTheDocument());
  });

  it("blocks a second send while a turn is still streaming", async () => {
    let finish!: () => void;
    mocks.chatMessageStream.mockImplementation(
      (_id: number, message: string, handlers: ChatStreamHandlers) =>
        new Promise<void>((resolve) => {
          handlers.onToken?.("streaming ");
          finish = () => {
            handlers.onDone?.(makeTurn({ id: 3, message }));
            resolve();
          };
        }),
    );

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("chat-assistant-turn")).toHaveLength(2));

    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "first question" } });
    fireEvent.click(screen.getByTestId("chat-composer-send"));
    await waitFor(() => expect(screen.getByTestId("chat-streaming-answer")).toBeInTheDocument());

    // While streaming, the send button is disabled and Enter is a no-op, so the
    // condensation window can always see the previous turn.
    fireEvent.change(screen.getByTestId("chat-composer-input"), { target: { value: "second question" } });
    expect(screen.getByTestId("chat-composer-send")).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("chat-composer-input"), { key: "Enter" });
    expect(mocks.chatMessageStream).toHaveBeenCalledTimes(1);

    act(() => finish());
    await waitFor(() => expect(screen.getByTestId("chat-composer-send")).not.toBeDisabled());
  });
});
