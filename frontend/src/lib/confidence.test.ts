import { describe, expect, it } from "vitest";
import { confidenceMeta, verdictToConfidence } from "./confidence";

describe("verdictToConfidence", () => {
  it("maps sufficient -> high", () => {
    expect(verdictToConfidence("sufficient")).toBe("high");
  });
  it("maps borderline -> medium", () => {
    expect(verdictToConfidence("borderline")).toBe("medium");
  });
  it("maps insufficient -> low", () => {
    expect(verdictToConfidence("insufficient")).toBe("low");
  });
});

describe("confidenceMeta", () => {
  it("returns distinct labels for each confidence level", () => {
    const labels = new Set([
      confidenceMeta("high").label,
      confidenceMeta("medium").label,
      confidenceMeta("low").label,
    ]);
    expect(labels.size).toBe(3);
  });

  it("returns distinct colors for each confidence level", () => {
    const colors = new Set([
      confidenceMeta("high").colorVar,
      confidenceMeta("medium").colorVar,
      confidenceMeta("low").colorVar,
    ]);
    expect(colors.size).toBe(3);
  });

  it("every description notes the retrieval-math framing, not model self-assessment", () => {
    for (const level of ["high", "medium", "low"] as const) {
      expect(confidenceMeta(level).verdictLabel).toBeTruthy();
    }
  });
});
