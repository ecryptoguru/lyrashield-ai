import { expect, test } from "@playwright/test"

test("actual film presents native frames without decoder seeks", async ({ page }) => {
  test.skip(
    Boolean(process.env.CI),
    "Actual-film local measurement; CI covers native playback with synthetic media"
  )
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready", {
    timeout: 15000,
  })
  const result = await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>("[data-world-video]")!
    const times: number[] = []
    let seeks = 0
    video.addEventListener("seeking", () => seeks++)
    await new Promise<void>((resolve) => {
      const frame: VideoFrameRequestCallback = (now) => {
        times.push(now)
        if (times.length < 90) video.requestVideoFrameCallback(frame)
        else resolve()
      }
      video.requestVideoFrameCallback(frame)
    })
    const intervals = times
      .slice(1)
      .map((time, i) => time - times[i]!)
      .sort((a, b) => a - b)
    return { seeks, p95: intervals[Math.floor(intervals.length * 0.95)]!, max: intervals.at(-1)! }
  })
  expect(result.seeks).toBe(0)
  expect(result.p95).toBeLessThan(60)
  expect(result.max).toBeLessThan(150)
})
