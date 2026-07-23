import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DrawerProvider } from "@/store/drawer";
import type { Citation } from "@/api/types";
import { AnswerRenderer } from "./AnswerRenderer";

function citation(marker: number, artifact_id: string): Citation {
  return {
    marker,
    artifact_id,
    title: `${artifact_id} title`,
    source: "plm",
    tier_label: "formal",
    chunk_idx: 0,
    char_start: 0,
    char_end: 10,
    passage: "Grounding passage.",
    grounded: true,
  };
}

function renderAnswer(answer: string, citations: Citation[] = [], streaming = false) {
  return render(
    <DrawerProvider>
      <AnswerRenderer answer={answer} citations={citations} streaming={streaming} />
    </DrawerProvider>,
  );
}

describe("AnswerRenderer", () => {
  it("renders plain prose paragraphs with interactive citation chips, as before", () => {
    const answer =
      "Engineering Change Request ECR-214. [1] Engineering Change Notice ECN-312. [2]\n\nRelated records are linked in the knowledge graph.";
    const { container } = renderAnswer(answer, [citation(1, "ECR-214"), citation(2, "ECN-312")]);

    const body = screen.getByTestId("answer-body");
    expect(body.querySelectorAll("p")).toHaveLength(2);
    expect(body).toHaveTextContent("Engineering Change Request ECR-214.");
    const chips = screen.getAllByTestId("citation-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-marker", "1");
    expect(chips[0]!.tagName).toBe("BUTTON");
    // No markdown structures invented for plain prose.
    expect(container.querySelector("table, ul, ol, h1, h2")).toBeNull();
  });

  it("renders a GFM table in a scroll container, with chips inside table cells", () => {
    const answer = [
      "The timeline is:",
      "",
      "| Date | Event |",
      "|---|---|",
      "| 2023-09 | Thermal event KES-208 [1] |",
      "| 2023-12 | ECN approved [2] |",
    ].join("\n");
    const { container } = renderAnswer(answer, [citation(1, "KES-208"), citation(2, "ECN-312")]);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table!.parentElement!.className).toContain("overflow-x-auto");
    expect(container.querySelectorAll("th")).toHaveLength(2);
    const cellChip = container.querySelector("td [data-testid='citation-chip']");
    expect(cellChip).not.toBeNull();
    expect(cellChip).toHaveAttribute("data-marker", "1");
    expect(cellChip!.closest("td")).toHaveTextContent("Thermal event KES-208");
  });

  it("renders lists with chips inside list items", () => {
    const answer = "Key changes:\n\n- Chemistry moved to LiFePO4 [1]\n- **BMS limits** updated [2]";
    const { container } = renderAnswer(answer, [citation(1, "ECR-214"), citation(2, "ECR-209")]);

    const items = container.querySelectorAll("ul li");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector("[data-testid='citation-chip']")).toHaveAttribute("data-marker", "1");
    // A chip after bold text inside a list item still renders.
    expect(items[1]!.querySelector("strong")).toHaveTextContent("BMS limits");
    expect(items[1]!.querySelector("[data-testid='citation-chip']")).toHaveAttribute("data-marker", "2");
  });

  it("never executes or mounts raw HTML from the model output", () => {
    const answer =
      'Safe text. [1] <script>window.hacked = true</script> <img src=x onerror="window.hacked = true"> done.';
    const { container } = renderAnswer(answer, [citation(1, "ECR-214")]);

    // No live elements are created from the raw HTML...
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    // ...while the surrounding markdown still renders.
    expect(screen.getByTestId("answer-body")).toHaveTextContent("Safe text.");
    expect(screen.getByTestId("answer-body")).toHaveTextContent("done.");
    expect(screen.getByTestId("citation-chip")).toBeInTheDocument();
  });

  it("renders inert marker chips (no buttons) while streaming", () => {
    const { container } = renderAnswer("Partial answer [1] still stream", [], true);
    expect(container.querySelector("button")).toBeNull();
    expect(screen.getByTestId("answer-body")).toHaveTextContent("Partial answer");
    expect(screen.getByTestId("answer-body")).toHaveTextContent("1");
  });

  it("falls back to a placeholder chip for an unknown marker", () => {
    renderAnswer("Claim. [7]", []);
    const chip = screen.getByTestId("citation-chip");
    expect(chip).toHaveAttribute("data-marker", "7");
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("Unknown source"));
  });
});
