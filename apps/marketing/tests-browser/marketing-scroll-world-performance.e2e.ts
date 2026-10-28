import { expect, test } from "@playwright/test"

test("actual film follows jumps and presents continuous scroll frames", async ({
  page,
}, testInfo) => {
  test.skip(Boolean(process.env.CI), "Actual-film local measurement; CI uses synthetic media")
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready", {
    timeout: 15000,
  })
  const result = await page.evaluate(async () => {
    const world = document.querySelector<HTMLElement>("scroll-world")!
    const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
    const catchup: number[] = []
    for (const id of ["target", "retest", "scan", "report", "target"]) {
      const el = document.querySelector(`#journey-${id}`)!
      const start = performance.now()
      scrollTo({ top: el.getBoundingClientRect().top + scrollY - 200, behavior: "instant" })
      await raf()
      await raf()
      while (
        Math.abs(Number(world.dataset.worldTime) - Number(world.dataset.worldPresented)) > 0.04
      ) {
        if (performance.now() - start > 3000) throw new Error("Scroll film did not converge")
        await raf()
      }
      catchup.push(performance.now() - start)
    }
    scrollTo({ top: 500, behavior: "instant" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const times: number[] = []
    let previous = world.dataset.worldPresented
    const observer = new MutationObserver(() => {
      if (previous !== world.dataset.worldPresented) {
        previous = world.dataset.worldPresented
        times.push(performance.now())
      }
    })
    observer.observe(world, { attributes: true, attributeFilter: ["data-world-presented"] })
    const start = performance.now()
    while (performance.now() - start < 3000) {
      scrollTo({ top: 500 + (performance.now() - start) * 0.65, behavior: "instant" })
      await raf()
    }
    observer.disconnect()
    const intervals = times
      .slice(1)
      .map((time, i) => time - times[i]!)
      .sort((a, b) => a - b)
    return {
      catchup,
      frames: times.length,
      p95: intervals[Math.floor(intervals.length * 0.95)]!,
      max: intervals.at(-1)!,
      state: world.dataset.worldState,
    }
  })
  await testInfo.attach("actual-film-timings", {
    body: JSON.stringify(result),
    contentType: "application/json",
  })
  expect(result.frames).toBeGreaterThan(60)
  expect(Math.max(...result.catchup)).toBeLessThan(
    (page.viewportSize()?.width ?? 1440) < 768 ? 500 : 250
  )
  expect(result.p95).toBeLessThan(60)
  expect(result.max).toBeLessThan(150)
  expect(result.state).toBe("ready")
})
