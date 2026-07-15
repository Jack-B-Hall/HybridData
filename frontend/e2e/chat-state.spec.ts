import { expect, test } from "@playwright/test";
import { mockApiRoutes, fixtures } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

async function askStarter(page: import("@playwright/test").Page, match: string) {
  await page.getByTestId("starter-question").filter({ hasText: match }).click();
}

test("chat history survives navigating to Documents and back", async ({ page }) => {
  await page.goto("/");
  await askStarter(page, "LiPo to LiFePO4");

  // First answer resolves.
  const turns = page.getByTestId("chat-turn");
  await expect(turns).toHaveCount(1);
  await expect(turns.first().getByTestId("answer-body")).toBeVisible();

  // Ask a second, different question via the input.
  await page.getByTestId("ask-input").fill(fixtures.askImpact.question);
  await page.getByTestId("ask-submit").click();
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1).getByTestId("answer-body")).toBeVisible();

  // Open a source in the slide-over, then jump to the full document.
  await turns.first().getByTestId("source-card").first().click();
  await expect(page.getByTestId("source-drawer")).toBeVisible();
  await page.getByTestId("drawer-open-document").click();

  await expect(page).toHaveURL(/\/documents\//);
  await expect(page.getByTestId("document-title")).toBeVisible();

  // Back to Chat — the full two-question history is still there, no reload.
  await page.getByRole("link", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/$|\/$/);
  await expect(page.getByTestId("chat-turn")).toHaveCount(2);
  await expect(page.getByTestId("answer-body").first()).toBeVisible();
});

test("removing one question deletes only that block; clear all wipes history", async ({ page }) => {
  await page.goto("/");
  await askStarter(page, "LiPo to LiFePO4");
  await page.getByTestId("ask-input").fill(fixtures.askImpact.question);
  await page.getByTestId("ask-submit").click();

  const turns = page.getByTestId("chat-turn");
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1).getByTestId("answer-body")).toBeVisible();

  // Remove the first question — the second remains.
  await turns.first().hover();
  await turns.first().getByTestId("remove-turn").click();
  await expect(turns).toHaveCount(1);

  // Clear all (with confirm) empties the chat.
  await page.getByTestId("clear-all").click();
  await page.getByTestId("clear-all-confirm-yes").click();
  await expect(page.getByTestId("chat-turn")).toHaveCount(0);
  await expect(page.getByTestId("starter-question").first()).toBeVisible();
});
