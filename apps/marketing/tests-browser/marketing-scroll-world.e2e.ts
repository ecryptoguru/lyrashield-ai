import { expect, test } from "@playwright/test"

test("native cinema plays smoothly while scrolling never seeks", async ({ page }) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("[data-world-video]")!
    video.dataset.seeks = "0"
    video.addEventListener("seeking", () => {
      video.dataset.seeks = String(Number(video.dataset.seeks) + 1)
    })
  })
  const video = page.locator("[data-world-video]")
  const before = await video.evaluate((v) => (v as HTMLVideoElement).currentTime)
  for (const id of ["target", "retest", "scan", "gateway"]) {
    await page.locator(`#journey-${id}`).scrollIntoViewIfNeeded()
    await expect(world).toHaveAttribute("data-world-state", "ready")
  }
  await expect(video).toHaveAttribute("data-seeks", "0")
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(before)
  expect(await video.evaluate((v) => (v as HTMLVideoElement).playbackRate)).toBe(1)
  await expect(video).toBeVisible()
})

test("motion off releases media and can restart", async ({ page }) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  await page.locator("[data-world-toggle]").click()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await page.locator("[data-world-toggle]").click()
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
})

test("reduced motion requests no film", async ({ page }) => {
  const requests: string[] = []
  page.on("request", (r) => {
    if (r.url().endsWith(".mp4")) requests.push(r.url())
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "static")
  expect(requests).toHaveLength(0)
  await expect(page.getByRole("heading", { name: "Set the scope." })).toBeAttached()
})
