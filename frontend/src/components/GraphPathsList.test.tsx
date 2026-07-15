import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GraphPathsList } from "./GraphPathsList";

function renderPaths(paths: string[]) {
  return render(
    <MemoryRouter>
      <GraphPathsList paths={paths} />
    </MemoryRouter>,
  );
}

describe("GraphPathsList", () => {
  it("links each node and the relationship into the graph explorer", () => {
    renderPaths(["ECR-214 (Battery cell chemistry change) -AFFECTS-> P-1062 (Battery Cell Assembly)"]);

    const nodeLinks = screen.getAllByTestId("graph-path-node");
    expect(nodeLinks).toHaveLength(2);
    expect(nodeLinks[0]).toHaveAttribute("href", "/explorer/graph?node=ECR-214");
    expect(nodeLinks[1]).toHaveAttribute("href", "/explorer/graph?node=P-1062");

    expect(screen.getByTestId("graph-path-rel")).toHaveAttribute(
      "href",
      "/explorer/graph?node=ECR-214&edge=P-1062",
    );
  });

  it("renders a non-parseable path as plain text, no links", () => {
    renderPaths(["some free-form path without any ids"]);
    expect(screen.queryByTestId("graph-path-node")).toBeNull();
    expect(screen.queryByTestId("graph-path-rel")).toBeNull();
    expect(screen.getByText("some free-form path without any ids")).toBeInTheDocument();
  });
});
