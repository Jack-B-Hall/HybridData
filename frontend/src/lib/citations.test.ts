import { describe, expect, it } from "vitest";
import { citationMarkersIn, parseInlineCitations } from "./citations";

describe("parseInlineCitations", () => {
  it("splits plain text with no markers into a single text part", () => {
    const parts = parseInlineCitations("no markers here");
    expect(parts).toEqual([{ type: "text", value: "no markers here" }]);
  });

  it("extracts a single trailing marker", () => {
    const parts = parseInlineCitations("Engineering Change Request ECR-214. [1]");
    expect(parts).toEqual([
      { type: "text", value: "Engineering Change Request ECR-214. " },
      { type: "citation", marker: 1 },
    ]);
  });

  it("extracts multiple markers interleaved with text", () => {
    const parts = parseInlineCitations("A [1] B [2] C");
    expect(parts).toEqual([
      { type: "text", value: "A " },
      { type: "citation", marker: 1 },
      { type: "text", value: " B " },
      { type: "citation", marker: 2 },
      { type: "text", value: " C" },
    ]);
  });

  it("handles adjacent markers with no text between them", () => {
    const parts = parseInlineCitations("[1][2]");
    expect(parts).toEqual([
      { type: "citation", marker: 1 },
      { type: "citation", marker: 2 },
    ]);
  });

  it("handles a marker with double-digit numbers", () => {
    const parts = parseInlineCitations("See [12] for details");
    expect(parts).toEqual([
      { type: "text", value: "See " },
      { type: "citation", marker: 12 },
      { type: "text", value: " for details" },
    ]);
  });
});

describe("citationMarkersIn", () => {
  it("matches the real ask_sufficient fixture answer shape", () => {
    const answer =
      "Engineering Change Request ECR-214. [1] Engineering Change Notice ECN-312. [2] K-200 Battery System Specification [3]\n\nRelated records are linked in the knowledge graph (40 relationship paths surfaced).";
    expect(citationMarkersIn(answer)).toEqual([1, 2, 3]);
  });

  it("returns a sorted, de-duplicated list of markers", () => {
    expect(citationMarkersIn("[2] [1] [2] [3]")).toEqual([1, 2, 3]);
  });

  it("returns an empty array when there are no markers", () => {
    expect(citationMarkersIn("no citations here")).toEqual([]);
  });
});
