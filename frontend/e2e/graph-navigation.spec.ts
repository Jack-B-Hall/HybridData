import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("a graph-path node link focuses the explorer, hops to a neighbor, and returns to chat with history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();

  // The graph-paths section links each node into the Data Explorer. P-1062 is a
  // path target that resolves in the mock graph.
  const nodeLink = turn.locator('[data-testid="graph-path-node"][data-node-id="P-1062"]').first();
  await expect(nodeLink).toBeVisible();
  await nodeLink.click();

  // The explorer opens focused on that node, deep-linked and inspector populated.
  await expect(page).toHaveURL(/\/explorer\/graph\?node=P-1062/);
  const panel = page.getByTestId("graph-node-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("P-1062");
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();

  // Hop to a neighbor from the inspector — focus moves and a back affordance appears.
  await panel.getByTestId("graph-relationship-row").first().click();
  await expect(page).not.toHaveURL(/node=P-1062(&|$)/);
  await expect(page.getByTestId("graph-node-panel")).toBeVisible();
  await expect(page.getByTestId("graph-back")).toBeVisible();

  // Back button walks the trail back to P-1062.
  await page.getByTestId("graph-back").click();
  await expect(page).toHaveURL(/node=P-1062/);

  // Return to Chat — the full answer history survived the round trip (no reload).
  await page.getByRole("link", { name: "Interface", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("chat-turn")).toHaveCount(1);
  await expect(page.getByTestId("answer-body").first()).toBeVisible();
});

test("a relationship link deep-links to the edge and shows the typed relationship", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();
  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();

  // Click a relationship whose endpoints resolve in the mock graph (…-AFFECTS-> P-1062).
  const relForP1062 = turn
    .locator('[data-testid="graph-path"]', { has: page.locator('[data-node-id="P-1062"]') })
    .first()
    .getByTestId("graph-path-rel");
  await relForP1062.click();

  await expect(page).toHaveURL(/\/explorer\/graph\?node=.*&edge=P-1062/);
  await expect(page.getByTestId("graph-focused-relationship")).toBeVisible();
});
