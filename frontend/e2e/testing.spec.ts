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

test("add a question with a golden answer, run it, and see the composite + rubric + justification", async ({ page }) => {
  await page.goto("/testing");

  // Add a golden question WITH a golden answer through the editor.
  await page.getByTestId("golden-add").click();
  await page.getByTestId("editor-text").fill("Does the sonar transducer meet spec?");
  await page.getByTestId("editor-category").fill("lookup");
  await page.getByTestId("editor-golden-answer").fill("Yes, after the AquaSound Corp vendor change.");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("golden-row")).toHaveCount(3);
  await expect(page.getByTestId("golden-answer-badge").first()).toBeVisible();

  // Kick a run; progress shows, then a history row appears with a composite score.
  await expect(page.getByTestId("test-history")).toContainText("No test runs yet");
  await page.getByTestId("run-tests").click();
  await expect(page.getByTestId("test-progress")).toBeVisible();

  const row = page.getByTestId("test-run-row").first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText("score");

  // Expand the run, then expand a per-question result to reveal the rubric + rationale.
  await row.getByRole("button").first().click();
  await expect(page.getByTestId("test-run-detail")).toBeVisible();
  const result = page.getByTestId("test-result-row").filter({ hasText: "sonar transducer" });
  await expect(result).toBeVisible();
  await result.click();
  const detail = page.getByTestId("test-result-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Correctness");
  await expect(detail).toContainText("Judge rationale");
});

test("the how-this-is-scored panel explains the composite formula and same-model bias", async ({ page }) => {
  await page.goto("/testing");
  const explainer = page.getByTestId("scoring-explainer");
  await expect(explainer).toContainText("composite =");
  await explainer.getByRole("button").first().click();
  await expect(explainer).toContainText("LLM-as-judge");
  await expect(page.getByTestId("judge-bias-warning")).toBeVisible();
});

test("golden questions can be filtered by behaviour", async ({ page }) => {
  await page.goto("/testing");
  await expect(page.getByTestId("golden-row")).toHaveCount(2);
  await page.getByLabel("Filter by behaviour").selectOption("refuse");
  await expect(page.getByTestId("golden-row")).toHaveCount(1);
  await expect(page.getByTestId("golden-row").first()).toContainText("firmware");
});
