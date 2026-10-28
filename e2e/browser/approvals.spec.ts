import { test, expect } from "@playwright/test"

for (const width of [390, 1280]) {
  test(`an open approval confirmation expires safely at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install({ time: new Date("2026-10-28T00:00:00Z") })
    let submissions = 0
    await page.route("**/api/agent-approvals/**", async (route) => {
      submissions++
      await route.fulfill({ json: { success: true, data: {} } })
    })
    await page.goto("?approvals")
    await page.getByRole("button", { name: "Approve", exact: true }).click()
    await expect(page.getByRole("button", { name: "Approve action", exact: true })).toBeVisible()
    await page.clock.fastForward(60_000)
    await expect(page.getByText("Request expired", { exact: false })).toBeVisible()
    await expect(page.getByRole("button", { name: "Approve action", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("expired-approval.png"), fullPage: true })
    expect(submissions).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
