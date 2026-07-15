import { describe, expect, it, vi } from "vitest";
import { consumeSseStream, dispatchEvent, extractFrames, frameData, parseFrame } from "./sse";
import type { AskStreamHandlers, StreamEvent } from "@/api/types";

describe("extractFrames", () => {
  it("splits complete frames and returns the unterminated remainder", () => {
    const { frames, rest } = extractFrames("data: a\n\ndata: b\n\ndata: par");
    expect(frames).toEqual(["data: a", "data: b"]);
    expect(rest).toBe("data: par");
  });

  it("returns no frames when nothing is terminated yet", () => {
    const { frames, rest } = extractFrames("data: partial");
    expect(frames).toEqual([]);
    expect(rest).toBe("data: partial");
  });
});

describe("frameData", () => {
  it("strips the data: prefix and one optional space", () => {
    expect(frameData("data: {\"type\":\"token\"}")).toBe('{"type":"token"}');
  });

  it("returns null for a frame with no data line", () => {
    expect(frameData(": comment")).toBeNull();
  });
});

describe("parseFrame", () => {
  it("parses a token event", () => {
    expect(parseFrame('data: {"type":"token","text":"hi"}')).toEqual({ type: "token", text: "hi" });
  });

  it("returns null on malformed JSON", () => {
    expect(parseFrame("data: {not json")).toBeNull();
  });
});

describe("dispatchEvent", () => {
  it("routes each event type to its handler", () => {
    const handlers: AskStreamHandlers = {
      onRetrieval: vi.fn(),
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    dispatchEvent({ type: "token", text: "x" } as StreamEvent, handlers);
    dispatchEvent({ type: "error", message: "boom" } as StreamEvent, handlers);
    expect(handlers.onToken).toHaveBeenCalledWith("x");
    expect(handlers.onError).toHaveBeenCalledWith("boom");
    expect(handlers.onRetrieval).not.toHaveBeenCalled();
  });
});

describe("consumeSseStream", () => {
  it("dispatches events across chunk boundaries", async () => {
    const chunks = [
      'data: {"type":"token","text":"Hel"}\n\ndata: {"type":"to',
      'ken","text":"lo"}\n\ndata: {"type":"error","message":"done"}\n\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const tokens: string[] = [];
    const errors: string[] = [];
    await consumeSseStream(stream, { onToken: (t) => tokens.push(t), onError: (m) => errors.push(m) });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(errors).toEqual(["done"]);
  });
});
