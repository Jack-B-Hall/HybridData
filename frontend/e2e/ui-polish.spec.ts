import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("the primary tab is labelled Interface, with Chat as a separate tab", async ({ page }) => {
  await page.goto("/");
  const interfaceLink = page.getByRole("link", { name: "Interface", exact: true });
  await expect(interfaceLink).toBeVisible();
  await expect(interfaceLink).toHaveAttribute("href", "/");
  // The multi-turn Chat tab lives at /chat; the single-shot page keeps "/".
  await expect(page.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("href", "/chat");
});

test("a Q/A block collapses to a compact row and re-expands, surviving tab nav", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("starter-question").filter({ hasText: "LiPo to LiFePO4" }).click();

  const turn = page.getByTestId("chat-turn").first();
  await expect(turn.getByTestId("answer-body")).toBeVisible();

  // Collapse: the answer body hides, the confidence pill stays on the compact row.
  await turn.getByTestId("collapse-turn").click();
  await expect(turn.getByTestId("answer-body")).toBeHidden();
  await expect(turn.getByTestId("confidence-indicator")).toBeVisible();

  // The collapsed state persists across a tab switch (chat state is lifted).
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await page.getByRole("link", { name: "Interface", exact: true }).click();
  await expect(page.getByTestId("chat-turn").first().getByTestId("answer-body")).toBeHidden();

  // Re-expand restores the full answer.
  await page.getByTestId("chat-turn").first().getByTestId("collapse-turn").click();
  await expect(page.getByTestId("chat-turn").first().getByTestId("answer-body")).toBeVisible();
});
