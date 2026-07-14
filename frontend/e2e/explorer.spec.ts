import { expect, test } from "@playwright/test";
import { mockApiRoutes, fixtures } from "./fixtures/api-mock";

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("the data explorer graph tab renders an interactive knowledge graph", async ({ page }) => {
  await page.goto("/explorer/graph");

  await expect(page.getByTestId("graph-legend")).toBeVisible();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  // react-force-graph-2d renders onto a <canvas>.
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();

  await expect(page.getByTestId("graph-node-panel-empty")).toBeVisible();
});

test("clicking a graph node loads its neighborhood into the side panel", async ({ page }) => {
  await page.goto(`/explorer/graph?node=${fixtures.graphNode.center}`);

  const panel = page.getByTestId("graph-node-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(fixtures.graphNode.center);
});

test("the data explorer documents table renders sortable, filterable rows", async ({ page }) => {
  await page.goto("/explorer/table");

  const table = page.getByTestId("documents-table");
  await expect(table).toBeVisible();

  const rows = table.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("table-row-link").first()).toBeVisible();

  await page.getByTestId("table-search").fill(fixtures.documents.documents[0]!.id);
  await expect(table).toContainText(fixtures.documents.documents[0]!.id);
});

test("the data explorer analytics tab renders corpus stat cards and ingestion history", async ({ page }) => {
  await page.goto("/explorer/analytics");

  await expect(page.getByTestId("analytics-view")).toBeVisible();
  const statCards = page.getByTestId("stat-card");
  await expect(statCards).toHaveCount(4);
  await expect(page.getByTestId("ingest-history")).toContainText(fixtures.ingestHistory.runs[0]!.adapter);
});
