import { expect, test } from "@playwright/test"
import { MOTION_FPS } from "../../marketing-motion/scripts/motion-media-contract.mjs"

test("startup presents its first frame before accepting scroll seeks", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.addEventListener
    HTMLVideoElement.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) {
      if (type !== "loadedmetadata" || typeof listener !== "function")
        return original.call(this, type, listener, options)
      const video = this
      return original.call(
        this,
        type,
        (event) => setTimeout(() => listener.call(video, event), 180),
        options
      )
    }
    document.addEventListener(
      "seeking",
      (event) => {
        const world = document.querySelector("scroll-world") as HTMLElement | null
        if (event.target instanceof HTMLVideoElement && world && !world.dataset.worldPresented)
          world.dataset.earlySeek = "true"
      },
      true
    )
  })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
  expect(await world.getAttribute("data-early-seek")).toBeNull()
})

test("wheel-sized steps ease the video in both directions while the page moves immediately", async ({
  page,
}) => {
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
  for (const delta of [120, -120]) {
    const trace = await page.evaluate(async (delta) => {
      const world = document.querySelector<HTMLElement>("scroll-world")!
      const video = world.querySelector<HTMLVideoElement>("video")!
      const frames = [Number(world.dataset.worldPresented)]
      let callback = 0
      const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (metadata.mediaTime !== frames.at(-1)) frames.push(metadata.mediaTime)
        callback = video.requestVideoFrameCallback(observe)
      }
      callback = video.requestVideoFrameCallback(observe)
      const before = scrollY
      scrollTo({ top: before + delta, behavior: "instant" })
      const pageMoved = scrollY - before
      await new Promise((resolve) => setTimeout(resolve, 400))
      video.cancelVideoFrameCallback(callback)
      return {
        frames,
        pageMoved,
        target: Number(world.dataset.worldTime),
        presented: Number(world.dataset.worldPresented),
      }
    }, delta)
    expect(trace.pageMoved).toBe(delta)
    const distance = Math.abs(trace.target - trace.frames[0]!)
    const steps = trace.frames.slice(1).map((frame, i) => Math.abs(frame - trace.frames[i]!))
    expect(distance).toBeGreaterThan(0.5)
    expect(trace.frames.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...steps)).toBeLessThan(distance * 0.85)
    expect(Math.abs(trace.presented - trace.target)).toBeLessThan(1.1 / MOTION_FPS)
  }
})

test("full animation presents the correct frames through forward and reverse navigation", async ({
  page,
}) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "ready", { timeout: 10000 })
  await expect(world).toHaveAttribute("data-world-painted", "true")
  const video = page.locator("[data-world-video]")
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth > 0)).toBe(true)
  const links = page
    .getByRole("navigation", { name: "Evidence journey chapters" })
    .getByRole("link")
  for (const index of [1, 3, 6, 4, 2, 0]) {
    await links.nth(index).click()
    await expect(links.nth(index)).toHaveAttribute("aria-current", "step")
    await expect
      .poll(async () =>
        world.evaluate((element) => {
          const desired = Number((element as HTMLElement).dataset.worldTime)
          const presented = Number((element as HTMLElement).dataset.worldPresented)
          return Math.abs(desired - presented)
        })
      )
      .toBeLessThan(1.1 / MOTION_FPS)
    await expect(world).toHaveAttribute("data-world-state", "ready")
    await expect(world).toHaveAttribute("data-world-painted", "true")
  }
  if (test.info().project.name === "mobile") {
    await page.locator("#journey-report").scrollIntoViewIfNeeded()
    const motion = await page.getByRole("button", { name: "Motion on" }).boundingBox()
    const cta = await page.locator("[data-sticky-cta]").boundingBox()
    expect(motion && cta && motion.y + motion.height <= cta.y).toBe(true)
    const nav = await page
      .getByRole("navigation", { name: "Evidence journey chapters" })
      .boundingBox()
    expect(motion && nav && motion.y + motion.height <= nav.y + nav.height).toBe(true)
  }
  await expect(page.locator(".journey__nav a[aria-current]")).toHaveCSS("color", "rgb(17, 51, 59)")
  await page.getByRole("button", { name: "Motion on" }).click()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(video).not.toHaveAttribute("src", /.+/)
  await page.reload()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(page.locator("h1")).toBeVisible()
})

test("an observed media failure enters bounded fallback and retains working controls", async ({
  page,
}) => {
  let requests = 0
  await page.route("**/assurance-world/v3/**/*.mp4", async (route) => {
    requests++
    await route.fulfill({ status: 404, body: "missing" })
  })
  await page.goto("/")
  await expect.poll(() => requests).toBeGreaterThan(0)
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "fallback")
  await expect(page.locator("h1")).toBeVisible()
  await page.getByRole("link", { name: "See a sample Lite result" }).click()
  await expect(page.locator("#free-scan")).toBeInViewport()
  await page.unroute("**/assurance-world/v3/**/*.mp4")
  await page.getByRole("button", { name: "Motion unavailable" }).click()
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "ready")
})

test("metadata without a presented frame reaches the watchdog fallback", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = function () {
      return original.call(this, () => {})
    }
  })
  let observed = false
  page.on("request", (request) => {
    if (request.url().includes("assurance-world.mp4")) observed = true
  })
  await page.goto("/")
  await expect.poll(() => observed).toBe(true)
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "fallback", {
    timeout: 7000,
  })
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await page.getByRole("link", { name: "See a sample Lite result" }).click()
  await expect(page.locator("#free-scan")).toBeInViewport()
})

test("a late presented frame corrects drift and completes the pending seek", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback
    let delayed = false
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const video = this
      return original.call(video, (now, metadata) => {
        const world = document.querySelector("scroll-world") as HTMLElement & { inFlight?: boolean }
        if (!delayed && world?.inFlight && !video.paused) {
          delayed = true
          setTimeout(() => original.call(video, callback), 300)
          return
        }
        callback(now, metadata)
      })
    }
  })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
  await page
    .getByRole("navigation", { name: "Evidence journey chapters" })
    .getByRole("link")
    .nth(6)
    .click()
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
  expect(
    await page
      .locator("[data-world-video]")
      .evaluate((video: HTMLVideoElement) => video.playbackRate)
  ).toBe(0.25)
})

test("reduced motion never requests the film and keeps the story usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("assurance-world.mp4")) requests.push(request.url())
  })
  await page.goto("/")
  await page.locator("#journey-report").scrollIntoViewIfNeeded()
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "static")
  await expect(page.locator("#journey-report")).toContainText("limits")
  expect(requests).toEqual([])
})

test("preference and orientation changes release the old decoder and recover", async ({ page }) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  const video = page.locator("[data-world-video]")
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.locator("#journey-retest").scrollIntoViewIfNeeded()
  await page.setViewportSize({ width: 768, height: 1024 })
  await expect(video).toHaveAttribute("src", /portrait\/assurance-world.mp4/)
  await expect(world).toHaveAttribute("data-world-state", "ready")
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.videoHeight > element.videoWidth)
  ).toBe(true)
  await page.setViewportSize({ width: 844, height: 390 })
  // Native page reflow can move the chapter outside the viewport after rotation.
  await page.locator("#journey-retest").scrollIntoViewIfNeeded()
  await expect(video).toHaveAttribute("src", /desktop\/assurance-world.mp4/)
  await expect(world).toHaveAttribute("data-world-painted", "true")
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.videoWidth > element.videoHeight)
  ).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator("#journey-retest").scrollIntoViewIfNeeded()
  await expect(video).toHaveAttribute("src", /portrait\/assurance-world.mp4/)
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(video).not.toHaveAttribute("src", /.+/)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(world).toHaveAttribute("data-world-state", "ready")
  await expect(world).toHaveAttribute("data-world-painted", "true")
  expect(await video.count()).toBe(1)
})

test("mobile hero exposes the scene while keeping signup in the first viewport", async ({
  page,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 360, height: 800 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("/")
    const world = page.locator("scroll-world")
    await expect(world).toHaveAttribute("data-world-painted", "true")
    const stage = await page.locator(".scroll-world__stage").boundingBox()
    const title = await page.locator("#premium-hero-title").boundingBox()
    const action = await page.locator(".premium-hero__primary").boundingBox()
    expect(stage && title && title.y - stage.y >= Math.floor(viewport.height * 0.2)).toBe(true)
    expect(action && action.y + action.height <= viewport.height).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width
    )
  }
})

test("Save-Data requests no film and retains interactive chapter content", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "connection", { value: { saveData: true } })
  )
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("assurance-world.mp4")) requests.push(request.url())
  })
  await page.goto("/")
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "static")
  await page.locator("#journey-report summary").click()
  await expect(page.locator("#journey-report details")).toHaveAttribute("open", "")
  expect(requests).toEqual([])
})

test("the complete story and conversion links work without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("/")
  await expect(page.locator("h1")).toBeVisible()
  await expect(page.locator("[data-world-toggle]")).toBeHidden()
  await page.locator("#journey-report summary").click()
  await expect(page.locator("#journey-report details")).toHaveAttribute("open", "")
  await expect(page.locator("#journey-report")).toContainText("limits")
  await expect(
    page.getByRole("link", { name: "Start free trial", exact: true }).first()
  ).toHaveAttribute("href", /sign-up/)
  await context.close()
})

test("ordinary scrolling settles within one frame at arbitrary chapter positions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.locator("#journey-evidence-state").scrollIntoViewIfNeeded()
  await expect(page.locator('[href="#journey-evidence-state"][data-journey-link]')).toHaveAttribute(
    "aria-current",
    "step"
  )
  const requested = Number(await world.getAttribute("data-world-time")) * MOTION_FPS
  expect(Math.abs(requested - Math.round(requested))).toBeLessThan(0.02)
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
})
