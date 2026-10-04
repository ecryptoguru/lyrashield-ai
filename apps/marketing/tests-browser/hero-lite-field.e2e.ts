import { expect, test } from "@playwright/test"

/**
 * Hero URL field (handoff item 3.1b).
 *
 * The field hands the visitor's URL to /scan through sessionStorage. Consent
 * lives in the hero because /scan pre-checks its own box and auto-submits, so a
 * hero form without recorded consent would start a scan nobody agreed to.
 *
 * In this preview build PUBLIC_SCANNER_URL is a placeholder, so the field is
 * disabled and cannot be driven. The enabled path is covered by
 * src/tests/hero-lite-handoff.test.ts, which exercises the shared module
 * directly; these tests cover the render and the disabled contract.
 */
const FIELD = "#hero-lite-form"
const URL_INPUT = "#hero-scan-url"
const CONSENT = "#hero-scan-authorized"

test("renders the hero field with its own ids and a consent box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await expect(page.locator(FIELD)).toBeVisible()
  await expect(page.locator(URL_INPUT)).toBeVisible()
  await expect(page.locator(CONSENT)).toBeAttached()
  await expect(page.locator("#hero-scan-error")).toBeAttached()

  // The field's ids must not collide with the Lite Check section lower down.
  for (const id of ["home-lite-scan-form", "home-scan-url", "home-scan-authorized"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1)
  }

  // No horizontal overflow at 390px with the field present.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(1)
})

test("stacks the field and button at 390px with touch-sized targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const input = await page.locator(URL_INPUT).boundingBox()
  const button = await page.locator(".premium-hero__field-button").boundingBox()
  expect(input).not.toBeNull()
  expect(button).not.toBeNull()
  // 44px minimum touch target.
  expect(input!.height).toBeGreaterThanOrEqual(44)
  expect(button!.height).toBeGreaterThanOrEqual(44)
  // The button stacks under the field rather than sitting beside it.
  expect(button!.y, "the button stacks below the field").toBeGreaterThanOrEqual(
    input!.y + input!.height - 1
  )
  expect(button!.x, "the button is not pushed off the right edge").toBeGreaterThanOrEqual(0)
})

test("keeps the no-JavaScript fallback in the markup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  // <noscript> content is not rendered when scripting is on, so the fallback is
  // asserted from the served markup. A JS-disabled context cannot be used here:
  // with no JavaScript the page's reveal animation never runs and its content
  // stays transparent, which no visibility assertion can see through.
  const fallback = page.locator(`${FIELD} noscript a[href="/scan"]`)
  await expect(fallback).toHaveCount(1)
  await expect(fallback).toHaveText("Open the free Lite Check")

  // With no JavaScript the form posts natively to /scan with no query string.
  await expect(page.locator(FIELD)).toHaveAttribute("action", "/scan")
  await expect(page.locator(FIELD)).toHaveAttribute("method", "get")
  // The field must carry no name, or a native GET submit would put the typed
  // URL in the query string.
  await expect(page.locator(URL_INPUT)).not.toHaveAttribute("name", /./)
})

test("does not put the typed URL into the page URL", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const before = page.url()
  await page.locator(URL_INPUT).fill("https://example.com")
  await page
    .locator(CONSENT)
    .check({ force: true })
    .catch(() => {})
  expect(page.url()).toBe(before)
  expect(page.url()).not.toContain("example.com")
})
