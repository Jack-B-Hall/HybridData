import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("the Ingestion tab is in the nav and shows the corpus summary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Ingestion", exact: true }).click();
  await expect(page).toHaveURL(/\/ingestion/);
  await expect(page.getByTestId("corpus-summary")).toBeVisible();
  await expect(page.getByTestId("summary-card").first()).toBeVisible();
});

test("scan runs, shows progress, then a history row appears", async ({ page }) => {
  await page.goto("/ingestion");
  await expect(page.getByTestId("ingest-history")).toContainText("No ingest runs yet");

  await page.getByTestId("ingest-scan").click();
  await expect(page.getByTestId("ingest-progress")).toBeVisible();

  const row = page.getByTestId("ingest-history-row").first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText("scan");
});

test("clear is gated behind a typed CLEAR confirmation", async ({ page }) => {
  await page.goto("/ingestion");
  await page.getByTestId("ingest-clear").click();

  const modal = page.getByTestId("clear-confirm-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("clear-confirm-submit")).toBeDisabled();

  await page.getByTestId("clear-confirm-input").fill("CLEAR");
  await expect(page.getByTestId("clear-confirm-submit")).toBeEnabled();
  await page.getByTestId("clear-confirm-submit").click();

  await expect(modal).toBeHidden();
  await expect(page.getByTestId("ingest-history-row").first()).toContainText("clear", { timeout: 5000 });
});
