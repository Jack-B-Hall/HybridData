import { expect, test } from "@playwright/test";
import { mockApiRoutes } from "./fixtures/api-mock";

test("disabled tabs are hidden from the nav and their routes redirect", async ({ page }) => {
  await mockApiRoutes(page, {
    tabs: { interface: true, chat: true, documents: true, explorer: true, ingestion: false, testing: false },
  });
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Ingestion" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Testing" })).toHaveCount(0);

  // Deep link into a disabled tab redirects to the first enabled tab.
  await page.goto("/testing");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("ask-input")).toBeVisible();
});

test("disabling the interface tab redirects / to the next enabled tab (Chat)", async ({ page }) => {
  await mockApiRoutes(page, {
    tabs: { interface: false, chat: true, documents: true, explorer: true, ingestion: true, testing: true },
  });
  await page.goto("/");

  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("chat-composer-input")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Interface", exact: true })).toHaveCount(0);
});

test("all tabs enabled shows the full nav including Chat", async ({ page }) => {
  await mockApiRoutes(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Interface", "Chat", "Documents", "Data Explorer", "Ingestion", "Testing"]) {
    await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
});
