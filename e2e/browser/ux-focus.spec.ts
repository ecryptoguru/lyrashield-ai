import { expect, test } from "@playwright/test"

/**
 * W1/P2-3 and W1/P2-4 in a real browser: an error that appears above a long
 * step must move focus and scroll to itself, and the billing upgrade control
 * must move the user to the plan picker instead of reloading the page.
 */

for (const width of [390, 768, 1440]) {
  test(`onboarding alert takes focus and comes into view at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setViewportSize({ width, height: 844 })
    await page.goto("?ux")

    const start = page.getByRole("button", { name: "Start release check" })
    await start.scrollIntoViewIfNeeded()
    await start.click()

    const alert = page.getByRole("alert").filter({ hasText: "Too many scans" })
    await expect(alert).toBeVisible()
    await expect(alert).toBeFocused()
    // The button the user pressed is far below the alert; without the scroll
    // the user sees the spinner stop and nothing else.
    const inViewport = await alert.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top >= 0 && box.top < window.innerHeight
    })
    expect(inViewport).toBe(true)
    expect(errors).toEqual([])
  })
}

test("a plain onboarding error also takes focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("?ux")

  const trigger = page.getByRole("button", { name: "Start with a plain error" })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Workspace and repository are required." })
  await expect(alert).toBeFocused()
})

test("a mapped admission failure keeps its retry and its recovery link", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("?ux")

  await page.getByRole("button", { name: "Start release check" }).click()
  const alert = page.getByRole("alert").filter({ hasText: "Too many scans" })
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(alert.getByRole("link", { name: "Open the recovery page" })).toHaveAttribute(
    "href",
    "/dashboard/scans"
  )
})

/**
 * W1/P2-1 — a lost connection does not establish whether the scan was accepted.
 * The only retry the surface may offer is a status read; a plain "Try again"
 * could start a second paid scan.
 */
test("an unknown outcome offers a status check, never a plain retry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("?ux")

  const trigger = page.getByRole("button", { name: "Simulate a lost connection" })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()

  const alert = page.getByRole("alert").filter({ hasText: "connection dropped" })
  await expect(alert).toBeFocused()
  await expect(alert.getByRole("button", { name: "Check the scan status" })).toBeVisible()
  await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(alert).toContainText("duplicate paid scan")
})

test("Upgrade Now focuses the plan picker without navigating", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("?ux=billing")

  const url = page.url()
  const upgrade = page.getByRole("button", { name: "Upgrade Now" })
  await expect(upgrade).toHaveAttribute("aria-controls", "choose-plan")
  await upgrade.click()

  // No reload, no navigation: the page and its URL are unchanged.
  await expect(page).toHaveURL(url)
  await expect(page.getByRole("heading", { name: "Trial status" })).toBeVisible()

  const picker = page.locator("#choose-plan")
  await expect(picker).toBeVisible()
  await expect(
    picker.getByRole("button", { name: /^Choose Starter, monthly billing/ })
  ).toBeFocused()
  expect(
    await picker.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.top < window.innerHeight && box.bottom > 0
    })
  ).toBe(true)
  expect(errors).toEqual([])
})
