import { expect, test } from "@playwright/test";
import { mockApiRoutes, fixtures } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("asking a question renders the answer with interactive citation chips", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();
  await expect(turn.getByTestId("confidence-indicator")).toBeVisible();
  await expect(turn.getByTestId("confidence-indicator")).toContainText("High confidence");

  const chips = turn.getByTestId("citation-chip");
  await expect(chips).toHaveCount(fixtures.askSufficient.citations.length);

  await expect(turn.getByTestId("sources-panel")).toBeVisible();
  await expect(turn.getByTestId("sources-panel")).toContainText(fixtures.askSufficient.sources[0]!.artifact_id);
});

test("clicking a citation chip opens a popover with the grounding passage", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const firstChip = page.getByTestId("citation-chip").first();
  await firstChip.waitFor({ state: "visible" });
  await firstChip.click();

  const popover = page.getByTestId("citation-popover");
  await expect(popover).toBeVisible();

  const firstCitation = fixtures.askSufficient.citations[0]!;
  await expect(popover).toContainText(firstCitation.artifact_id);
  // The passage is the exact grounding text — assert a distinctive slice of it appears.
  await expect(popover).toContainText(firstCitation.passage.slice(0, 40));
});

test("opening the full document from a citation popover navigates to the highlighted viewer", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const firstChip = page.getByTestId("citation-chip").first();
  await firstChip.waitFor({ state: "visible" });
  await firstChip.click();

  await page.getByTestId("citation-open-document").click();

  const firstCitation = fixtures.askSufficient.citations[0]!;
  await expect(page).toHaveURL(new RegExp(`/documents/${firstCitation.artifact_id}\\?`));
  await expect(page.getByTestId("document-title")).toContainText(firstCitation.title);
  await expect(page.getByTestId("highlighted-passage")).toBeVisible();
});
