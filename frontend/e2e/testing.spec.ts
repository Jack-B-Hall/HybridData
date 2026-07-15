import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("the Testing tab is in the nav and shows the golden set", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Testing", exact: true }).click();
  await expect(page).toHaveURL(/\/testing/);
  await expect(page.getByTestId("golden-table")).toBeVisible();
  await expect(page.getByTestId("golden-row").first()).toBeVisible();
});

test("add a question, run the suite, and see a history row with per-question results", async ({ page }) => {
  await page.goto("/testing");

  // Add a golden question through the editor.
  await page.getByTestId("golden-add").click();
  await page.getByTestId("editor-text").fill("Does the sonar transducer meet spec?");
  await page.getByTestId("editor-category").fill("lookup");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("golden-row")).toHaveCount(3);

  // Kick a run; progress shows, then a history row appears.
  await expect(page.getByTestId("test-history")).toContainText("No test runs yet");
  await page.getByTestId("run-tests").click();
  await expect(page.getByTestId("test-progress")).toBeVisible();

  const row = page.getByTestId("test-run-row").first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText("passed");

  // Expand the run to reveal per-question results.
  await row.getByRole("button").first().click();
  await expect(page.getByTestId("test-run-detail")).toBeVisible();
  await expect(page.getByTestId("test-result-row").first()).toBeVisible();
  await expect(page.getByTestId("test-result-row").first()).toContainText("pass");
});

test("golden questions can be filtered by behaviour", async ({ page }) => {
  await page.goto("/testing");
  await expect(page.getByTestId("golden-row")).toHaveCount(2);
  await page.getByLabel("Filter by behaviour").selectOption("refuse");
  await expect(page.getByTestId("golden-row")).toHaveCount(1);
  await expect(page.getByTestId("golden-row").first()).toContainText("firmware");
});
