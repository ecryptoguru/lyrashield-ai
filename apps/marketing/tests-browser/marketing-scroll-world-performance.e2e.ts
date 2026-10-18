import { expect, test } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { MOTION_FPS } from "../../marketing-motion/scripts/motion-media-contract.mjs"

for (const rate of [1, 4, 6]) {
  test(`presented-frame catch-up under ${rate}x CPU throttling`, async ({ page }, info) => {
    test.skip(
      Boolean(process.env.CI),
      "Actual-film performance requires the reviewed media; synthetic CI fixtures do not establish this gate"
    )
    test.setTimeout(60000)
    const session = await page.context().newCDPSession(page)
    await session.send("Emulation.setCPUThrottlingRate", { rate })
    const start = Date.now()
    await page.goto("/")
    await expect(page.locator("scroll-world")).toHaveAttribute("data-world-painted", "true", {
      timeout: 10000,
    })
    const startupMs = Date.now() - start
    const results = await page.evaluate(async (fps) => {
      const world = document.querySelector<HTMLElement>("scroll-world")!
      const chapters = Array.from(document.querySelectorAll<HTMLElement>("[data-journey-chapter]"))
      const trials: number[] = []
      const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      for (let i = 0; i < 40; i++) {
        const index = [1, 5, 2, 6][i % 4]!
        const top = chapters[index]!.getBoundingClientRect().top + scrollY
        const begin = performance.now()
        scrollTo({ top, behavior: "instant" })
        await tick()
        await tick()
        while (
          Math.abs(Number(world.dataset.worldTime) - Number(world.dataset.worldPresented)) >
            1.1 / fps ||
          world.dataset.worldPainted !== "true"
        ) {
          if (world.dataset.worldState === "fallback")
            throw new Error("Unexpected runtime fallback")
          if (performance.now() - begin > 2000)
            throw new Error(
              `Presented-frame timeout: ${world.dataset.worldTime}/${world.dataset.worldPresented}`
            )
          await tick()
        }
        trials.push(performance.now() - begin)
      }
      const sorted = [...trials].sort((a, b) => a - b)
      return { trials, p95: sorted[38]!, max: sorted[39]!, state: world.dataset.worldState }
    }, MOTION_FPS)
    mkdirSync("../../output/playwright/scroll-world", { recursive: true })
    writeFileSync(
      `../../output/playwright/scroll-world/catchup-${info.project.name}-${rate}x.json`,
      JSON.stringify({ startupMs, rate, ...results }, null, 2)
    )
    expect(results.state).toBe("ready")
    expect(results.p95).toBeLessThan(info.project.name === "mobile" ? 500 : 250)
    await session.detach()
  })
}

test("cold ranged startup on a 4 Mbit/s connection", async ({ page }, info) => {
  test.skip(Boolean(process.env.CI), "Requires the actual reviewed film")
  test.setTimeout(60000)
  const session = await page.context().newCDPSession(page)
  await session.send("Network.enable")
  await session.send("Network.setCacheDisabled", { cacheDisabled: true })
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 500000,
    uploadThroughput: 500000,
  })
  await session.send("Emulation.setCPUThrottlingRate", {
    rate: info.project.name === "mobile" ? 4 : 1,
  })
  const mediaRequests = new Set<string>()
  let mediaBytes = 0
  session.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (request.url.includes("assurance-world.mp4")) mediaRequests.add(requestId)
  })
  session.on("Network.dataReceived", ({ requestId, encodedDataLength }) => {
    if (mediaRequests.has(requestId)) mediaBytes += encodedDataLength
  })
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const world = document.querySelector<HTMLElement>("scroll-world")
      if (world?.dataset.worldState === "loading" && !world.dataset.labStart)
        world.dataset.labStart = String(performance.now())
      if (world?.dataset.worldPainted === "true" && !world.dataset.labPresented)
        world.dataset.labPresented = String(performance.now())
    })
    observer.observe(document, { subtree: true, attributes: true, childList: true })
  })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 15000 })
  const startupMs = await world.evaluate(
    (element) =>
      Number((element as HTMLElement).dataset.labPresented) -
      Number((element as HTMLElement).dataset.labStart)
  )
  const startupBytes = mediaBytes
  await page
    .getByRole("navigation", { name: "Evidence journey chapters" })
    .getByRole("link")
    .nth(6)
    .click()
  await expect(world).toHaveAttribute("data-world-state", "ready")
  await expect
    .poll(() =>
      world.evaluate((element) =>
        Math.abs(
          Number((element as HTMLElement).dataset.worldTime) -
            Number((element as HTMLElement).dataset.worldPresented)
        )
      )
    )
    .toBeLessThan(1.1 / MOTION_FPS)
  mkdirSync("../../output/playwright/scroll-world", { recursive: true })
  writeFileSync(
    `../../output/playwright/scroll-world/cold-${info.project.name}.json`,
    JSON.stringify(
      {
        startupMs,
        startupBytes,
        mediaBytes,
        requests: mediaRequests.size,
        profile: "4 Mbit/s, 150 ms RTT, empty cache",
      },
      null,
      2
    )
  )
  expect(startupMs).toBeLessThan(3000)
  expect(startupBytes).toBeGreaterThan(0)
  await session.detach()
})

test("native wheel reversal catches up without losing controls", async ({ page }, info) => {
  test.skip(Boolean(process.env.CI), "Requires the actual reviewed film")
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.locator("#journey-scan").scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const lab = { intervals: [] as number[], longTasks: [] as number[], stop: false }
    ;(window as unknown as { scrollLab: typeof lab }).scrollLab = lab
    let previous = performance.now()
    const tick = (now: number) => {
      lab.intervals.push(now - previous)
      previous = now
      if (!lab.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    new PerformanceObserver((list) => {
      lab.longTasks.push(...list.getEntries().map((entry) => entry.duration))
    }).observe({ type: "longtask", buffered: false })
  })
  for (const delta of [260, 260, 260, -320, -320, 240, -260, 360, 360, -460]) {
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(40)
  }
  const settled = Date.now()
  await expect
    .poll(() =>
      world.evaluate((element) =>
        Math.abs(
          Number((element as HTMLElement).dataset.worldTime) -
            Number((element as HTMLElement).dataset.worldPresented)
        )
      )
    )
    .toBeLessThan(1.1 / MOTION_FPS)
  await expect(world).toHaveAttribute("data-world-state", "ready")
  await expect(page.getByRole("button", { name: "Motion on" })).toBeVisible()
  const metrics = await page.evaluate(() => {
    const lab = (
      window as unknown as {
        scrollLab: { intervals: number[]; longTasks: number[]; stop: boolean }
      }
    ).scrollLab
    lab.stop = true
    const intervals = [...lab.intervals].sort((a, b) => a - b)
    return {
      rafP95: intervals[Math.floor(intervals.length * 0.95)],
      rafMax: intervals.at(-1),
      longTasks: lab.longTasks,
    }
  })
  mkdirSync("../../output/playwright/scroll-world", { recursive: true })
  writeFileSync(
    `../../output/playwright/scroll-world/wheel-${info.project.name}.json`,
    JSON.stringify(
      {
        catchupMs: Date.now() - settled,
        ...metrics,
        note: "rAF intervals are main-thread scheduling, not compositor FPS",
      },
      null,
      2
    )
  )
  await session.detach()
})

test("continuous scrolling presents an even sequence of new video frames", async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.CI), "Requires the actual reviewed film")
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.locator("#journey-scan").scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      world.evaluate((el) =>
        Math.abs(
          Number((el as HTMLElement).dataset.worldTime) -
            Number((el as HTMLElement).dataset.worldPresented)
        )
      )
    )
    .toBeLessThan(1.1 / MOTION_FPS)
  const frames = await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>("[data-world-video]")!
    const startY = scrollY
    const begin = performance.now()
    const frames: { time: number; media: number }[] = []
    let callback = 0
    const observe = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (metadata.mediaTime !== frames.at(-1)?.media)
        frames.push({ time: now - begin, media: metadata.mediaTime })
      callback = video.requestVideoFrameCallback(observe)
    }
    callback = video.requestVideoFrameCallback(observe)
    await new Promise<void>((resolve) => {
      const move = (now: number) => {
        const elapsed = now - begin
        const offset = elapsed < 3000 ? elapsed * 0.3 : 1800 - elapsed * 0.3
        scrollTo({ top: startY + offset, behavior: "instant" })
        if (elapsed < 6000) requestAnimationFrame(move)
        else resolve()
      }
      requestAnimationFrame(move)
    })
    video.cancelVideoFrameCallback(callback)
    return frames
  })
  const moving = frames.filter(({ time }) => time > 250 && time < 5900)
  const intervals = moving
    .slice(1)
    .map((frame, i) => frame.time - moving[i]!.time)
    .sort((a, b) => a - b)
  const p95 = intervals[Math.floor(intervals.length * 0.95)]!
  mkdirSync("../../output/playwright/scroll-world", { recursive: true })
  writeFileSync(
    `../../output/playwright/scroll-world/continuous-${info.project.name}.json`,
    JSON.stringify({ p95, max: intervals.at(-1), frames }, null, 2)
  )
  expect(moving.length).toBeGreaterThan(140)
  expect(p95).toBeLessThan(60)
  expect(intervals.at(-1)).toBeLessThan(150)
  await expect(world).toHaveAttribute("data-world-state", "ready")
  await session.detach()
})
