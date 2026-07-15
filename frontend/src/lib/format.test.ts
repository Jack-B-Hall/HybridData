import { describe, expect, it } from "vitest";
import { modelLabel } from "./format";

describe("modelLabel", () => {
  it("shortens an ollama gemma backend to name + size", () => {
    expect(modelLabel("ollama/gemma4:26b-a4b-it-qat")).toBe("gemma4 26B");
  });

  it("reads the size out of a bare model tag", () => {
    expect(modelLabel("ollama/llama3.1:8b")).toBe("llama3.1 8B");
  });

  it("labels the offline mock backend plainly", () => {
    expect(modelLabel("mock/mock")).toBe("offline model");
  });

  it("falls back gracefully on an empty backend", () => {
    expect(modelLabel("")).toBe("the model");
  });
});
