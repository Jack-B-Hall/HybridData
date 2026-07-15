import { describe, expect, it } from "vitest";
import { extractNodeId } from "./ids";

describe("extractNodeId", () => {
  it("pulls the leading artifact id out of a graph-path segment", () => {
    expect(extractNodeId("ECR-214 (Battery cell chemistry change: P-1062 Li)")).toBe("ECR-214");
    expect(extractNodeId("P-1062 (Battery Cell Assembly — LiFePO4)")).toBe("P-1062");
    expect(extractNodeId("E01 (Dr. Rhea Voss)")).toBe("E01");
    expect(extractNodeId("WIKI-052 (Battery Chemistry Design Review — 2023-1)")).toBe("WIKI-052");
  });

  it("returns null when the segment doesn't start with an id", () => {
    expect(extractNodeId("the knowledge graph")).toBeNull();
    expect(extractNodeId("")).toBeNull();
  });
});
