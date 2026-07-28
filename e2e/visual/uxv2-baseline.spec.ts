import { expect, test } from "@playwright/test"

test.describe("UX V2 baseline screenshots", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("dashboard home @visual", async ({ page }) => {
    await page.goto("/dashboard")
    await expect(page).toHaveTitle(/LyraShield/)
    await expect(page).toHaveScreenshot("dashboard-home.png", { fullPage: true })
  })

  test("products list @visual", async ({ page }) => {
    await page.goto("/dashboard/products")
    await expect(page).toHaveTitle(/LyraShield/)
    await expect(page).toHaveScreenshot("products-list.png", { fullPage: true })
  })

  test("run detail @visual", async ({ page }) => {
    // Placeholder route used for baseline capture; replace with a real scan id.
    await page.goto("/dashboard/scans/placeholder")
    await expect(page).toHaveTitle(/LyraShield/)
    await expect(page).toHaveScreenshot("run-detail.png", { fullPage: true })
  })

  test("issue detail @visual", async ({ page }) => {
    // Placeholder route used for baseline capture; replace with a real finding id.
    await page.goto("/dashboard/findings/placeholder")
    await expect(page).toHaveTitle(/LyraShield/)
    await expect(page).toHaveScreenshot("issue-detail.png", { fullPage: true })
  })

  test("onboarding step 1 @visual", async ({ page }) => {
    await page.goto("/onboarding")
    await expect(page).toHaveTitle(/LyraShield/)
    await expect(page).toHaveScreenshot("onboarding-step-1.png", { fullPage: true })
  })
})
