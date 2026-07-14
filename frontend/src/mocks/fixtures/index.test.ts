import { describe, expect, it } from "vitest";
import { askImpact, askRefusal, askSufficient, pickAskFixture } from "./index";

describe("pickAskFixture", () => {
  it("matches the exact sufficient-answer starter question", () => {
    expect(pickAskFixture(askSufficient.question)).toBe(askSufficient);
  });

  it("matches the exact impact-analysis starter question", () => {
    expect(pickAskFixture(askImpact.question)).toBe(askImpact);
  });

  it("matches the off-corpus starter question to the genuine refusal fixture", () => {
    expect(pickAskFixture(askRefusal.question)).toBe(askRefusal);
  });

  it("is case-insensitive on exact matches", () => {
    expect(pickAskFixture(askSufficient.question.toUpperCase())).toBe(askSufficient);
  });

  it("routes battery-chemistry-shaped questions to the sufficient fixture", () => {
    expect(pickAskFixture("what changed the K-200 battery chemistry?")).toBe(askSufficient);
  });

  it("routes ECR-221/propulsion-shaped questions to the impact fixture", () => {
    expect(pickAskFixture("what does ECR-221 affect?")).toBe(askImpact);
  });

  it("falls back to a refusal-shaped result for genuinely unknown questions, echoing the typed text", () => {
    const result = pickAskFixture("what's the weather like on Mars?");
    expect(result.answered).toBe(false);
    expect(result.question).toBe("what's the weather like on Mars?");
    expect(result.sources).toEqual(askRefusal.sources);
  });
});
