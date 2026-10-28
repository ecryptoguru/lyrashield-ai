import { expect, test } from "@playwright/test"

test("offscreen video pauses and resumes without replacing its source", async ({ page }) => {
  await page.goto("/")
  const video = page.locator("[data-world-video]")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready", {
    timeout: 15000,
  })
  const source = await video.getAttribute("src")
  await page.locator("#faq").scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true)
  await page.locator("#journey-scan").scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false)
  await expect(video).toHaveAttribute("src", source!)
})

test("media failure preserves readable story and poster", async ({ page }) => {
  await page.route("**/*.mp4", (route) => route.abort())
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "fallback", {
    timeout: 15000,
  })
  await expect(page.locator("[data-world-poster] img")).toBeVisible()
  await expect(page.getByRole("link", { name: "Explore the workflow" })).toHaveAttribute(
    "href",
    "#how-it-works"
  )
})

test("height-only resize preserves the decoder", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready", {
    timeout: 15000,
  })
  const video = page.locator("[data-world-video]")
  const source = await video.getAttribute("src")
  await page.setViewportSize({ width: 390, height: 740 })
  await expect(video).toHaveAttribute("src", source!)
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready")
})
