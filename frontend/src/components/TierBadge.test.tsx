import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TierBadge } from "./TierBadge";

describe("TierBadge", () => {
  it("renders the formal tier label", () => {
    render(<TierBadge tier="formal" />);
    expect(screen.getByText("Formal")).toBeInTheDocument();
  });

  it("renders the unverified tier label", () => {
    render(<TierBadge tier="unverified" />);
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("renders the informal tier label", () => {
    render(<TierBadge tier="informal" />);
    expect(screen.getByText("Informal")).toBeInTheDocument();
  });

  it("exposes the tier via a data attribute for styling/testing hooks", () => {
    render(<TierBadge tier="formal" />);
    expect(screen.getByText("Formal").closest("[data-tier]")).toHaveAttribute("data-tier", "formal");
  });

  it("applies distinct classes across the three tiers (no color collisions)", () => {
    const { container: formal } = render(<TierBadge tier="formal" />);
    const { container: unverified } = render(<TierBadge tier="unverified" />);
    const { container: informal } = render(<TierBadge tier="informal" />);
    const classesOf = (c: HTMLElement) => c.querySelector("[data-tier]")?.className;
    const set = new Set([classesOf(formal), classesOf(unverified), classesOf(informal)]);
    expect(set.size).toBe(3);
  });
});
