import { expect, test } from "@playwright/test"

/**
 * Journey block fallback (redesign spec section 8 block 4, item 3.3).
 *
 * The journey follows one illustrative finding. With JavaScript off, with
 * reduced motion, or on a Save-Data connection it must degrade to the six steps
 * as a plain static list rather than an empty scene.
 *
 * With JavaScript off the reveal animation never runs, so nothing is held at
 * opacity 0 and every step is genuinely visible.
 */
// The manifest holds seven chapter blocks: a gateway intro that carries no
// number, then the six numbered steps of the loop. The spec's "six-step list"
// is those six numbered steps.
const CHAPTERS = 7
const LOOP_STEPS = 6

test("shows all six journey steps with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")

  // The journey block and its heading are present.
  await expect(page.locator("#how-it-works")).toBeVisible()
  await expect(page.locator("#journey-heading")).toHaveText("From target to verdict.")

  // Every chapter renders as a static step, and all of them are visible.
  const steps = page.locator(".journey__chapter")
  await expect(steps).toHaveCount(CHAPTERS)
  for (let index = 0; index < CHAPTERS; index += 1) {
    await expect(steps.nth(index)).toBeVisible()
  }

  const destinations = await page
    .getByRole("navigation", { name: "Evidence journey chapters" })
    .getByRole("link")
    .allTextContents()
  expect(destinations.map((text) => text.replace(/^\d+/, "").trim())).toEqual([
    "Overview",
    "Target",
    "Review",
    "Evidence",
    "Approval",
    "Retest",
    "Report",
  ])
  expect(destinations.slice(1)).toHaveLength(LOOP_STEPS)
  await expect(page.locator("evidence-journey video")).toHaveCount(0)
  await expect(page.locator(".journey__report")).toBeVisible()
  await context.close()
})

test("shows the static list under reduced motion", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")

  await expect(page.locator(".journey__chapter")).toHaveCount(CHAPTERS)
  // The controller must not switch the block into its pinned motion layout.
  await expect(page.locator("evidence-journey")).not.toHaveClass(/is-enhanced/)
  await context.close()
})

test("keeps the journey heading and the six steps on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await expect(page.locator("#journey-heading")).toBeVisible()
  await expect(page.locator(".journey__chapter")).toHaveCount(CHAPTERS)

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(1)
})
