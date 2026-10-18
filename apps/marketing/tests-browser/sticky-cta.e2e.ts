import { expect, test } from "@playwright/test"

/**
 * Sticky mobile CTA bar (redesign spec section 7, item 2.4).
 *
 * Runs in the mobile project (390x844). The bar appears on Home, Pricing and
 * Scan after one screen of scroll; it must not cover a form field the
 * visitor is typing into.
 */
const ELIGIBLE = ["/", "/pricing", "/scan"]

for (const path of ELIGIBLE) {
  test(`shows the sticky CTA on ${path} only after one screen of scroll`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(path)

    const bar = page.locator("[data-sticky-cta]")
    // Before scrolling, the bar is hidden.
    await expect(bar).toBeHidden()

    await page.evaluate(() => scrollTo(0, innerHeight + 200))
    await expect(bar).toBeVisible()
    await expect(bar.getByRole("link", { name: "Start free trial" })).toBeVisible()

    // Back to the top: hidden again.
    await page.evaluate(() => scrollTo(0, 0))
    await expect(bar).toBeHidden()
  })
}

test("hides the sticky CTA while a form field is focused so it cannot cover it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  // In a build where the scanner is not connected, the Lite Check field is
  // disabled and cannot take focus. The hide-on-focus contract is also covered
  // by the component assertions in src/tests/sticky-cta.test.ts.
  const field = page.locator("#hero-scan-url")
  test.skip(await field.isDisabled(), "scanner not connected in this build; the field is disabled")

  const bar = page.locator("[data-sticky-cta]")
  await page.evaluate(() => scrollTo(0, innerHeight + 200))
  await expect(bar).toBeVisible()

  await field.scrollIntoViewIfNeeded()
  await field.focus()
  await expect(field).toBeFocused()
  await expect(bar).toBeHidden()

  // Blurring brings it back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(bar).toBeVisible()
})

test("never renders the sticky CTA on an ineligible page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/methodology")
  await page.evaluate(() => scrollTo(0, innerHeight + 400))
  await expect(page.locator("[data-sticky-cta]")).toHaveCount(0)
})

test("focus handling hides the bar without changing scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.evaluate(() => scrollTo({ top: innerHeight + 300, behavior: "instant" }))
  const bar = page.locator("[data-sticky-cta]")
  await expect(bar).toBeVisible()
  const before = await page.evaluate(() => scrollY)
  await page.evaluate(() => {
    const field = document.createElement("input")
    field.id = "focus-probe"
    document.body.append(field)
    field.focus({ preventScroll: true })
  })
  await expect(bar).toBeHidden()
  expect(await page.evaluate(() => scrollY)).toBe(before)
  await page.locator("#focus-probe").evaluate((element) => (element as HTMLInputElement).blur())
  await expect(bar).toBeVisible()
})

test("does not show the sticky CTA on desktop widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")
  await page.evaluate(() => scrollTo(0, innerHeight + 200))
  await expect(page.locator("[data-sticky-cta]")).toBeHidden()
})
