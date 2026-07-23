import { describe, expect, it } from "vitest";
import { TABS, firstEnabledPath, isTabEnabled } from "./tabs";

describe("tab enablement", () => {
  it("treats a missing map or key as enabled (older backends)", () => {
    expect(isTabEnabled(undefined, "chat")).toBe(true);
    expect(isTabEnabled({}, "testing")).toBe(true);
    expect(isTabEnabled({ testing: true }, "chat")).toBe(true);
  });

  it("disables only tabs explicitly set to false", () => {
    const tabs = { testing: false, ingestion: false, chat: true };
    expect(isTabEnabled(tabs, "testing")).toBe(false);
    expect(isTabEnabled(tabs, "ingestion")).toBe(false);
    expect(isTabEnabled(tabs, "chat")).toBe(true);
    expect(isTabEnabled(tabs, "documents")).toBe(true);
  });

  it("redirects to the first enabled tab in nav order", () => {
    expect(firstEnabledPath(undefined)).toBe("/");
    expect(firstEnabledPath({ interface: false })).toBe("/chat");
    expect(firstEnabledPath({ interface: false, chat: false })).toBe("/documents");
  });

  it("falls back to the Interface path when everything is disabled", () => {
    const allOff = Object.fromEntries(TABS.map((t) => [t.key, false]));
    expect(firstEnabledPath(allOff)).toBe("/");
  });

  it("keeps the expected nav order with Chat second", () => {
    expect(TABS.map((t) => t.key)).toEqual([
      "interface", "chat", "documents", "explorer", "ingestion", "testing",
    ]);
  });
});
