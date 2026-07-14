import { describe, expect, it } from "vitest";
import { citationMarkersIn, parseAnswer, parseInlineCitations } from "./citations";

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

describe("parseAnswer", () => {
  it("splits into paragraphs on newlines, dropping blank lines", () => {
    const paragraphs = parseAnswer("Line one. [1]\n\nLine two. [2]\n");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.heading).toBe(false);
    expect(paragraphs[1]!.heading).toBe(false);
  });

  it("treats a leading markdown heading as a soft heading, stripping the hashes", () => {
    const paragraphs = parseAnswer("# K-200 Battery System Specification [3]");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.heading).toBe(true);
    expect(paragraphs[0]!.parts[0]).toEqual({ type: "text", value: "K-200 Battery System Specification " });
    expect(paragraphs[0]!.parts[1]).toEqual({ type: "citation", marker: 3 });
  });

  it("matches the real ask_sufficient fixture answer shape", () => {
    const answer =
      "Engineering Change Request ECR-214. [1] Engineering Change Notice ECN-312. [2] # K-200 Battery System Specification [3]\n\nRelated records are linked in the knowledge graph (40 relationship paths surfaced).";
    const paragraphs = parseAnswer(answer);
    expect(paragraphs).toHaveLength(2);
    expect(citationMarkersIn(answer)).toEqual([1, 2, 3]);
  });
});

describe("citationMarkersIn", () => {
  it("returns a sorted, de-duplicated list of markers", () => {
    expect(citationMarkersIn("[2] [1] [2] [3]")).toEqual([1, 2, 3]);
  });

  it("returns an empty array when there are no markers", () => {
    expect(citationMarkersIn("no citations here")).toEqual([]);
  });
});
