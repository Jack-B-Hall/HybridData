import { expect, test } from "@playwright/test";
import { mockApiRoutes, fixtures } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("multi-turn follow-up: pronoun question is rewritten and answered with fresh citations", async ({ page }) => {
  await page.goto("/chat");

  // First turn: a standalone question (auto-creates the conversation).
  await page.getByTestId("chat-composer-input").fill(fixtures.askSufficient.question);
  await page.getByTestId("chat-composer-send").click();

  const turns = page.getByTestId("chat-assistant-turn");
  await expect(turns).toHaveCount(1);
  await expect(turns.first().getByTestId("answer-body")).toBeVisible();
  // A standalone question shows no rewrite note.
  await expect(page.getByTestId("rewrite-note")).toHaveCount(0);

  // Follow-up with a bare pronoun. The turn is condensed to a standalone
  // query anchored on the previously-cited records, shown as "searched for".
  await page.getByTestId("chat-composer-input").fill("what does it depend on?");
  await page.getByTestId("chat-composer-send").click();

  await expect(turns).toHaveCount(2);
  const followUp = turns.nth(1);
  await expect(followUp.getByTestId("rewrite-note")).toContainText("searched for:");
  await expect(followUp.getByTestId("rewrite-note")).toContainText("(context: ECR-214");
  await expect(followUp.getByTestId("answer-body")).toBeVisible();

  // The follow-up's citation chips resolve to real passages (reused drawer).
  await followUp.getByTestId("answer-body").getByTestId("citation-chip").first().click();
  await expect(page.getByTestId("source-drawer")).toBeVisible();
  await page.keyboard.press("Escape");

  // The conversation landed in the sidebar, titled from the first message.
  const item = page.getByTestId("conversation-item");
  await expect(item).toHaveCount(1);
  await expect(item.first().getByTestId("conversation-title")).toContainText("battery chemistry");
});

test("a mid-conversation off-corpus turn declines, then the thread keeps working", async ({ page }) => {
  await page.goto("/chat");

  await page.getByTestId("chat-composer-input").fill(fixtures.askSufficient.question);
  await page.getByTestId("chat-composer-send").click();
  const turns = page.getByTestId("chat-assistant-turn");
  await expect(turns.first().getByTestId("answer-body")).toBeVisible();

  // Off-corpus question mid-thread: the per-turn gate declines it.
  await page.getByTestId("chat-composer-input").fill(fixtures.askRefusal.question);
  await page.getByTestId("chat-composer-send").click();
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1).getByTestId("refusal-panel")).toBeVisible();

  // The conversation continues normally after the refusal.
  await page.getByTestId("chat-composer-input").fill(fixtures.askImpact.question);
  await page.getByTestId("chat-composer-send").click();
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(2).getByTestId("answer-body")).toBeVisible();
});

test("conversation management: new, rename, delete", async ({ page }) => {
  await page.goto("/chat");

  await page.getByTestId("chat-composer-input").fill(fixtures.askSufficient.question);
  await page.getByTestId("chat-composer-send").click();
  await expect(page.getByTestId("chat-assistant-turn").first().getByTestId("answer-body")).toBeVisible();

  // New conversation starts an empty thread.
  await page.getByTestId("new-conversation").click();
  await expect(page.getByTestId("conversation-item")).toHaveCount(2);
  await expect(page.getByTestId("chat-assistant-turn")).toHaveCount(0);

  // Rename the active conversation.
  const first = page.getByTestId("conversation-item").first();
  await first.hover();
  await first.getByTestId("rename-conversation").click();
  await page.getByTestId("rename-input").fill("Renamed thread");
  await page.getByTestId("rename-input").press("Enter");
  await expect(first.getByTestId("conversation-title")).toHaveText("Renamed thread");

  // Delete it (two-step confirm).
  await first.hover();
  await first.getByTestId("delete-conversation").click();
  await first.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("conversation-item")).toHaveCount(1);
});
