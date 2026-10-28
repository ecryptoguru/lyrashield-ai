import { expect, test } from "@playwright/test"

// The illustrative verdict now appears once, after the cinematic workflow.
for (const width of [390, 1280]) {
  test(`keeps the example honest and contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    const scene = page.locator("[data-journey-scene]")
    await expect(scene).toContainText("Illustrative example")
    await expect(scene.locator(".journey__badge")).toHaveText("Detected")
    await expect(scene).toContainText("Insufficient evidence")
    await expect(scene).toContainText("Incomplete coverage · inconclusive")
    await expect(scene).not.toContainText(/independently verified/i)
    expect(await scene.count()).toBe(1)
    const box = await scene.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  })
}

test("keeps signup in the first phone screen and the URL form in its dedicated section", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  for (const selector of ["#premium-hero-title", ".premium-hero__lede", ".premium-hero__primary"]) {
    const box = await page.locator(selector).boundingBox()
    expect(box!.y + box!.height).toBeLessThan(844)
  }
  await expect(page.locator(".premium-hero form")).toHaveCount(0)
  await expect(page.locator("#free-scan form")).toHaveCount(1)
})
