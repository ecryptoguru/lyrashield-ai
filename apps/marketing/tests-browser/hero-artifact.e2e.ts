import { expect, test } from "@playwright/test"

/**
 * Hero sample verdict card (redesign spec section 8 block 1, item 3.1).
 *
 * The card used to be hidden below 1024px, so the hero promise was invisible on
 * phones. It now renders at every width. These tests pin that, pin that it only
 * ever shows Detected findings and checks the stacked layout does not overflow.
 */
const CARD = ".premium-hero__artifact-card"

test("renders the sample verdict card on a phone without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const card = page.locator(CARD)
  await expect(card).toBeVisible()
  await expect(page.locator(".premium-hero__artifact-sample")).toBeVisible()
  await expect(card).toContainText("Insufficient evidence")
  await expect(card).toContainText("7 controls need your evidence")

  const box = await card.boundingBox()
  expect(box, "the card has a box at 390px").not.toBeNull()
  expect(box!.x, "the card starts inside the viewport").toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, "the card ends inside the viewport").toBeLessThanOrEqual(390)

  // The page itself must not scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(1)
})

test("shows only Detected findings on the sample card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const states = page.locator(".premium-hero__artifact-state")
  await expect(states).toHaveCount(2)
  for (const state of await states.allTextContents()) {
    expect(state.trim()).toBe("Detected")
  }

  // No verified state can appear anywhere in the hero artifact.
  const artifact = page.locator(".premium-hero__artifact")
  await expect(artifact).not.toContainText(/verified/i)
  await expect(artifact).not.toContainText(/retest-confirmed/i)
})

test("keeps the headline, lede and primary action in the first phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  for (const selector of ["#premium-hero-title", ".premium-hero__lede", ".premium-hero__primary"]) {
    const box = await page.locator(selector).boundingBox()
    expect(box, `${selector} has a box`).not.toBeNull()
    expect(box!.y, `${selector} sits inside the first 640px`).toBeLessThan(640)
  }

  // The card stacks under the actions rather than sitting beside them.
  const card = await page.locator(CARD).boundingBox()
  const actions = await page.locator(".premium-hero__actions").boundingBox()
  expect(card!.y).toBeGreaterThan(actions!.y)
})

test("renders the sample card at the desktop width too", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")

  await expect(page.locator(CARD)).toBeVisible()
  const box = await page.locator(CARD).boundingBox()
  expect(box!.x + box!.width, "the card stays inside the desktop viewport").toBeLessThanOrEqual(
    1280
  )
})
