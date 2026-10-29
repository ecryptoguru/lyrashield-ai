import { expect, test } from "@playwright/test"

test("offscreen suspension returns to scroll scrubbing without replacing its source", async ({
  page,
}) => {
  await page.goto("/")
  const video = page.locator("[data-world-video]")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready", {
    timeout: 15000,
  })
  const source = await video.getAttribute("src")
  await page.locator("#faq").scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true)
  await page.locator("#journey-scan").scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true)
  await expect(video).toHaveAttribute("src", source!)
  await expect
    .poll(() =>
      page
        .locator("scroll-world")
        .evaluate((el) =>
          Math.abs(
            Number((el as HTMLElement).dataset.worldTime) -
              Number((el as HTMLElement).dataset.worldPresented)
          )
        )
    )
    .toBeLessThan(0.04)
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

test("a failed media load can be retried without retaining the failed frame", async ({ page }) => {
  await page.route("**/*.mp4", (route) => route.abort())
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "fallback", { timeout: 15000 })
  await page.unroute("**/*.mp4")
  await page.locator("[data-world-toggle]").click()
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  await expect(page.locator(".scroll-world__canvas")).toHaveCSS("opacity", "1")
})

test("changing orientation replaces the film and preserves scroll position", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  await page.locator("#journey-scan").scrollIntoViewIfNeeded()
  const oldSource = await page.locator("[data-world-video]").getAttribute("src")
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", oldSource!)
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  await expect
    .poll(() =>
      world.evaluate((el) =>
        Math.abs(
          Number((el as HTMLElement).dataset.worldTime) -
            Number((el as HTMLElement).dataset.worldPresented)
        )
      )
    )
    .toBeLessThan(0.04)
})

test("motion off cancels an unfinished download without late activation", async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/*.mp4", async (route) => {
    await pending
    await route.abort().catch(() => {})
  })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "loading")
  await page.locator("[data-world-toggle]").click()
  release()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await expect(world).not.toHaveAttribute("data-world-painted", "true")
})

test("oversized film falls back before decoder activation", async ({ page }) => {
  await page.route("**/*.mp4", (route) =>
    route.fulfill({
      contentType: "video/mp4",
      body: Buffer.alloc(3 * 1024 * 1024 + 1),
    })
  )
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "fallback")
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
})
