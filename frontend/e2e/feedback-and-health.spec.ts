import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("thumbs-down with a comment records feedback and surfaces in system health", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();

  // Thumbs-down opens the optional comment box.
  await turn.getByTestId("feedback-down").click();
  const comment = turn.getByTestId("feedback-comment");
  await expect(comment).toBeVisible();
  await comment.getByTestId("feedback-comment-input").fill("Missed the incident date");
  await turn.getByTestId("feedback-comment-send").click();

  // The down thumb stays selected and a saved acknowledgement appears.
  await expect(turn.getByTestId("feedback-down")).toHaveAttribute("aria-pressed", "true");
  await expect(turn.getByTestId("feedback-thanks")).toBeVisible();

  // The System health view reflects the ask and the thumbs-down.
  await page.getByRole("link", { name: "Data Explorer", exact: true }).click();
  await page.getByRole("link", { name: "Analytics" }).click();

  const health = page.getByTestId("system-health");
  await expect(health).toBeVisible();
  await expect(health.getByTestId("recent-question-row").first()).toContainText("battery chemistry");
  await expect(health.getByText("👎").first()).toBeVisible();
});

test("thumbs-up feedback persists across a tab switch", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();
  await turn.getByTestId("feedback-up").click();
  await expect(turn.getByTestId("feedback-up")).toHaveAttribute("aria-pressed", "true");

  // Navigate away and back — the chosen rating survives (chat state is lifted).
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page).toHaveURL(/\/documents/);
  await page.getByRole("link", { name: "Interface", exact: true }).click();

  await expect(page.getByTestId("chat-turn").first().getByTestId("feedback-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
