import { expect, test } from "@playwright/test"
import {
  delayMotionNotifications,
  type DelayedMotionWindow,
} from "./helpers/delayed-motion-notifications"

// Controlled event-order regressions must also pass on the first attempt in CI.
test.describe.configure({ retries: 0 })

type Frame = {
  video: HTMLVideoElement
  callback: VideoFrameRequestCallback
  id: number
}
type RaceWindow = Window & { framesForTest: Frame[]; canceledForTest: number[] }

for (const initial of ["reduce", "no-preference"] as const) {
  test(`reduced motion keeps a decoded full-width poster from ${initial}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: initial })
    await page.goto("/")
    const world = page.locator("scroll-world")
    if (initial === "no-preference") {
      await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
      await page.emulateMedia({ reducedMotion: "reduce" })
    }
    await expect(world).toHaveAttribute("data-world-state", "static")
    const poster = page.locator("[data-world-poster] img")
    await poster.evaluate((image) => (image as HTMLImageElement).decode())
    await expect(poster).toBeVisible()
    await expect
      .poll(() =>
        poster.evaluate(
          (image) =>
            image.getBoundingClientRect().width /
            image.closest("scroll-world")!.getBoundingClientRect().width
        )
      )
      .toBeGreaterThan(0.99)
    await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  })
}

for (const trigger of ["seek", "deadline", "scroll"]) {
  test(`${trigger} reconciles reduced motion before a delayed preference notification`, async ({
    page,
  }) => {
    await page.addInitScript(delayMotionNotifications)
    await page.goto("/")
    const world = page.locator("scroll-world")
    await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.evaluate((trigger) => {
      if (trigger === "seek")
        document.querySelector("[data-world-video]")!.dispatchEvent(new Event("seeked"))
      else if (trigger === "scroll") window.dispatchEvent(new Event("scroll"))
      else (window as unknown as DelayedMotionWindow).deadlineForTest!()
    }, trigger)
    await expect(world).toHaveAttribute("data-world-state", "static")
    await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.evaluate(() => (window as unknown as DelayedMotionWindow).deliverMotionForTest())
    await expect(world).toHaveAttribute("data-world-painted", "true")
  })
}

test("a retired decoder watchdog cannot fail the replacement video", async ({ page }) => {
  await page.addInitScript(delayMotionNotifications)
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
  await page.getByRole("button", { name: "Motion on" }).click()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await page.getByRole("button", { name: "Motion off" }).click()
  await expect(world).toHaveAttribute("data-world-painted", "true")
  await page.evaluate(() => (window as unknown as DelayedMotionWindow).deadlineForTest!())
  await expect(world).toHaveAttribute("data-world-state", "ready")
  await expect(world).toHaveAttribute("data-world-painted", "true")
})

test("late seek events cannot resume frame observation after reduced motion", async ({ page }) => {
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(world).toHaveAttribute("data-world-state", "static")
  const requests = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>("scroll-world")!
    const video = world.querySelector<HTMLVideoElement>("video")!
    const callbacks: VideoFrameRequestCallback[] = []
    const original = video.requestVideoFrameCallback
    video.requestVideoFrameCallback = (callback) => {
      callbacks.push(callback)
      return 999999 + callbacks.length
    }
    // A seek event already queued by the retired decoder can still be delivered.
    video.dispatchEvent(new Event("seeked"))
    callbacks[0]?.(performance.now(), {
      mediaTime: Number(world.dataset.worldTime),
    } as VideoFrameCallbackMetadata)
    video.requestVideoFrameCallback = original
    return callbacks.length
  })
  expect(requests).toBe(0)
  await expect(world).toHaveAttribute("data-world-state", "static")
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(world).toHaveAttribute("data-world-painted", "true")
})

for (const event of ["loadedmetadata", "error"])
  test(`late ${event} cannot turn reduced motion into a media failure`, async ({ page }) => {
    await page.goto("/")
    const world = page.locator("scroll-world")
    await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(world).toHaveAttribute("data-world-state", "static")
    await page
      .locator("[data-world-video]")
      .evaluate((video, event) => video.dispatchEvent(new Event(event)), event)
    await expect(world).toHaveAttribute("data-world-state", "static")
    await expect(page.getByRole("button", { name: "Motion off" })).toBeVisible()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expect(world).toHaveAttribute("data-world-painted", "true")
  })

test("a retired frame callback cannot erase the current decoder cancellation handle", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as RaceWindow
    state.framesForTest = []
    state.canceledForTest = []
    const request = HTMLVideoElement.prototype.requestVideoFrameCallback
    const cancel = HTMLVideoElement.prototype.cancelVideoFrameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const id = request.call(this, callback)
      state.framesForTest.push({ video: this, callback, id })
      return id
    }
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
      state.canceledForTest.push(id)
      cancel.call(this, id)
    }
  })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 10000 })
  const oldIndex = await page.evaluate(
    () => (window as unknown as RaceWindow).framesForTest.length - 1
  )
  await page.getByRole("button", { name: "Motion on" }).click()
  await expect(world).toHaveAttribute("data-world-state", "static")
  await page.getByRole("button", { name: "Motion off" }).click()
  await expect(world).toHaveAttribute("data-world-painted", "true")
  const canceled = await page.evaluate((oldIndex) => {
    const state = window as unknown as RaceWindow
    const old = state.framesForTest[oldIndex]!
    const current = state.framesForTest.at(-1)!
    // Deliver an already queued callback after cancellation and a new load.
    old.callback(performance.now(), { mediaTime: 0 } as VideoFrameCallbackMetadata)
    document.querySelector<HTMLButtonElement>("[data-world-toggle]")!.click()
    return state.canceledForTest.includes(current.id)
  }, oldIndex)
  expect(canceled).toBe(true)
  await expect(world).toHaveAttribute("data-world-state", "static")
})
