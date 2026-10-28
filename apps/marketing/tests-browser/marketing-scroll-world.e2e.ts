import { expect, test } from "@playwright/test"

test("scroll controls paused film in both directions without autoplay", async ({ page }) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 15000 })
  let previous = 0
  for (const [id, direction] of [
    ["target", 1],
    ["retest", 1],
    ["scan", -1],
    ["report", 1],
    ["target", -1],
  ] as const) {
    await page.locator(`#journey-${id}`).evaluate((el) => {
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 200, behavior: "instant" })
    })
    // Wait for the scroll sample to change before testing convergence; the old
    // target and old frame can still agree immediately after scrollTo.
    await expect
      .poll(async () => Number(await world.getAttribute("data-world-time")))
      .not.toBe(previous)
    await expect
      .poll(async () =>
        world.evaluate((el) =>
          Math.abs(
            Number((el as HTMLElement).dataset.worldTime) -
              Number((el as HTMLElement).dataset.worldPresented)
          )
        )
      )
      .toBeLessThan(0.04)
    const presented = Number(await world.getAttribute("data-world-presented"))
    expect((presented - previous) * direction).toBeGreaterThan(0)
    previous = presented
    await expect(world).toHaveAttribute("data-world-state", "ready")
  }
  expect(
    await page.locator("[data-world-video]").evaluate((v) => (v as HTMLVideoElement).paused)
  ).toBe(true)
  await expect(page.locator(".scroll-world__canvas")).toHaveCSS("opacity", "1")
  const stopped = await world.getAttribute("data-world-presented")
  await page.waitForTimeout(250)
  await expect(world).toHaveAttribute("data-world-presented", stopped!)
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
