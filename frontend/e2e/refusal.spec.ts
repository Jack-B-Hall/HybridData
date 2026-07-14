import { expect, test } from "@playwright/test";
import { mockApiRoutes, fixtures } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("an off-corpus question renders the distinct refusal state, not an error", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("starter-question").filter({ hasText: "capital of France" }).click();

  const turn = page.getByTestId("chat-turn").first();
  const refusal = turn.getByTestId("refusal-panel");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("Not in the corpus");

  // It still surfaces what was found, framed as closest matches, not as an error.
  await expect(refusal).toContainText("Closest matches");
  const sourcesPanel = refusal.getByTestId("sources-panel");
  await expect(sourcesPanel).toContainText(fixtures.askRefusal.sources[0]!.artifact_id);

  // Confirm this is not rendered as an error block.
  await expect(turn.getByText("Something went wrong")).toHaveCount(0);
});
