import { test, expect } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"

test("compare native 30fps and 60fps presented-frame seek latency", async ({ page }) => {
  test.skip(
    Boolean(process.env.CI),
    "FPS comparison requires the separately rendered 30/60fps actual-world prototypes"
  )
  await page.goto("/")
  const results = await page.evaluate(async () => {
    const results = []
    for (const fps of [30, 60]) {
      const video = document.createElement("video")
      video.muted = true
      video.playsInline = true
      video.preload = "auto"
      video.style.cssText = "position:fixed;inset:0;width:640px;z-index:9999"
      document.body.append(video)
      const start = performance.now()
      const first = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("first frame timed out")), 5000)
        video.addEventListener(
          "loadeddata",
          () => {
            video.requestVideoFrameCallback(() => {
              clearTimeout(timer)
              video.pause()
              resolve(performance.now() - start)
            })
            void video.play()
          },
          { once: true }
        )
      })
      video.src = `/media-local/scroll-spike/desktop-${fps}.mp4`
      const firstMs = await first
      const trials = []
      for (let i = 0; i < 40; i++) {
        const target = i % 2 ? 3.7 : 0.1
        const begin = performance.now()
        const frame = await new Promise<{ ms: number; time: number }>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `seek timed out at ${target}: current=${video.currentTime}, seeking=${video.seeking}, ready=${video.readyState}, ranges=${video.seekable.length ? video.seekable.end(0) : 0}`
                )
              ),
            1500
          )
          video.requestVideoFrameCallback((_now, metadata) => {
            clearTimeout(timer)
            resolve({ ms: performance.now() - begin, time: metadata.mediaTime })
          })
          video.currentTime = target
        })
        trials.push({ ...frame, target })
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      const ordered = trials.map((trial) => trial.ms).sort((a, b) => a - b)
      results.push({ fps, firstMs, p95: ordered[38], max: ordered[39], trials })
      video.pause()
      video.removeAttribute("src")
      video.load()
      video.remove()
    }
    return results
  })
  mkdirSync("../../output/playwright/scroll-world", { recursive: true })
  writeFileSync(
    "../../output/playwright/scroll-world/fps-comparison.json",
    JSON.stringify(results, null, 2)
  )
  for (const result of results) {
    expect(result.firstMs).toBeLessThan(3000)
    expect(result.p95).toBeLessThan(250)
    expect(
      result.trials.every((trial) => Math.abs(trial.time - trial.target) < 1.1 / result.fps)
    ).toBe(true)
  }
})
