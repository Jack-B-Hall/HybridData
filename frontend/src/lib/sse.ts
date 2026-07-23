import type { AskStreamHandlers, ChatStreamEvent, ChatStreamHandlers, StreamEvent } from "@/api/types";

/**
 * Pull complete Server-Sent Events frames out of a rolling buffer. A frame is
 * terminated by a blank line (`\n\n`); whatever trails an unterminated frame is
 * returned as `rest` to be prepended to the next network chunk.
 */
export function extractFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    frames.push(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 2);
  }
  return { frames, rest: buffer };
}

/** Concatenate the `data:` lines of one SSE frame into their payload string. */
export function frameData(frame: string): string | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return data.length > 0 ? data : null;
}

/** Parse one SSE frame into a typed stream event, or null if it isn't one. */
export function parseFrame(frame: string): StreamEvent | null {
  const data = frameData(frame);
  if (data === null) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

/** Route a parsed event to the matching handler. */
export function dispatchEvent(event: StreamEvent, handlers: AskStreamHandlers): void {
  switch (event.type) {
    case "retrieval":
      handlers.onRetrieval?.(event);
      break;
    case "token":
      handlers.onToken?.(event.text);
      break;
    case "done":
      handlers.onDone?.(event.result);
      break;
    case "error":
      handlers.onError?.(event.message);
      break;
  }
}

/** Route a parsed chat-stream event (rewrite/retrieval/token/done/error). */
export function dispatchChatEvent(event: ChatStreamEvent, handlers: ChatStreamHandlers): void {
  switch (event.type) {
    case "rewrite":
      handlers.onRewrite?.(event);
      break;
    case "retrieval":
      handlers.onRetrieval?.(event);
      break;
    case "token":
      handlers.onToken?.(event.text);
      break;
    case "done":
      handlers.onDone?.(event.turn);
      break;
    case "error":
      handlers.onError?.(event.message);
      break;
  }
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  dispatch: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = extractFrames(buffer);
    buffer = rest;
    for (const frame of frames) dispatch(frame);
  }
  // Flush any trailing frame not followed by a blank line.
  const tail = buffer.trim();
  if (tail) dispatch(tail);
}

/**
 * Read an SSE response body to completion, dispatching each frame as it arrives.
 * Kept transport-agnostic (takes a ReadableStream) so it is unit-testable
 * without a real network.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: AskStreamHandlers,
): Promise<void> {
  await consumeStream(body, (frame) => {
    const event = parseFrame(frame);
    if (event) dispatchEvent(event, handlers);
  });
}

/** The chat-stream twin of {@link consumeSseStream} (done carries a turn). */
export async function consumeChatSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
): Promise<void> {
  await consumeStream(body, (frame) => {
    const data = frameData(frame);
    if (data === null) return;
    try {
      dispatchChatEvent(JSON.parse(data) as ChatStreamEvent, handlers);
    } catch {
      // ignore non-JSON frames
    }
  });
}
