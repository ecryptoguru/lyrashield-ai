import { expect, test } from "@playwright/test"

for (const path of [
  "/docs/integrations/cline",
  "/docs/integrations/openai-codex",
  "/docs/api",
  "/blog/cline-app-security-checklist",
  "/blog/cline-mcp-security-workflow",
  "/blog/amp-app-security-checklist",
]) {
  test(`launch review: narrow content fits ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(path)
    await page.evaluate(() => document.fonts.ready)
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    }))
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1)
    await expect(page.locator("h1")).toBeVisible()
  })
}
