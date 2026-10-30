import { expect, test } from "@playwright/test"
import { fastMotionConnection } from "./helpers/motion-connection"

// Keep local UX tests independent of authenticated production services.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/account/preferences", (route) =>
    route.fulfill({
      status: 401,
      json: {},
      headers: {
        "access-control-allow-origin": route.request().headers().origin ?? "*",
        "access-control-allow-credentials": "true",
      },
    })
  )
  await page.route("**/api/myra/status", (route) =>
    route.fulfill({
      json: { enabled: false },
      headers: {
        "access-control-allow-origin": route.request().headers().origin ?? "*",
        "access-control-allow-credentials": "true",
      },
    })
  )
})

const unknownConnection = () =>
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: undefined,
  })

test("CLI copy preserves the displayed command and reports clipboard rejection", async ({
  page,
}) => {
  await page.addInitScript(unknownConnection)
  await page.addInitScript(() => {
    const state = { text: "", fail: false }
    Object.assign(window, { clipboardForTest: state })
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          if (state.fail) throw new Error("clipboard denied")
          state.text = text
        },
      },
    })
  })
  await page.goto("/")
  await page.getByText("CLI setup", { exact: true }).click()
  const command = await page.locator("[data-cli-command]").textContent()
  expect(command).toMatch(/^npx .*lyrashield.* login/)
  await page.getByRole("button", { name: "Copy command", exact: true }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText("Copied")
  expect(
    await page.evaluate(
      () => (window as unknown as { clipboardForTest: { text: string } }).clipboardForTest.text
    )
  ).toBe(command)
  await page.evaluate(() => {
    ;(window as unknown as { clipboardForTest: { fail: boolean } }).clipboardForTest.fail = true
  })
  await page.getByRole("button", { name: "Copy command", exact: true }).click()
  await expect(page.locator("[data-copy-status]")).toHaveText(
    "Copy unavailable. Select the command to copy it."
  )
  await expect(page.getByRole("button", { name: "Copy command", exact: true })).toBeEnabled()
})

test("desktop disclosures dismiss on Escape, outside pointer and focus departure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(unknownConnection)
  await page.goto("/")
  const details = page.locator('details[name="desktop-navigation"]').first()
  const summary = details.locator("summary")
  await summary.focus()
  await summary.press("Enter")
  await expect(details).toHaveAttribute("open", "")
  // Safari's system keyboard preference may skip links on Tab; direct focus
  // still exercises Escape from inside the disclosure on every engine.
  await details.getByRole("link").first().focus()
  await expect(details.getByRole("link").first()).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(details).not.toHaveAttribute("open", "")
  await expect(summary).toBeFocused()
  await summary.click()
  await page.locator("h1").click()
  await expect(details).not.toHaveAttribute("open", "")
  await summary.click()
  await page.locator("#theme-toggle").focus()
  await expect(details).not.toHaveAttribute("open", "")
})

test("unknown network shows film size and Play; leaving releases resources and return loads once", async ({
  page,
}) => {
  await page.addInitScript(unknownConnection)
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("assurance-world.mp4")) requests.push(request.url())
  })
  await page.addInitScript(() => {
    const revoked: string[] = []
    Object.assign(window, { revokedForTest: revoked })
    const original = URL.revokeObjectURL
    URL.revokeObjectURL = (url) => {
      revoked.push(url)
      original(url)
    }
  })
  await page.goto("/")
  const world = page.locator("scroll-world")
  await expect(world).toHaveAttribute("data-world-state", "poster")
  await expect(
    page.getByRole("button", { name: /Play motion \(up to (10|16) MiB\)/ })
  ).toBeVisible()
  await page.waitForTimeout(300)
  expect(requests).toHaveLength(0)
  await page.locator("[data-world-status]").evaluate((status) => {
    const changes: string[] = []
    Object.assign(window, { statusForTest: changes })
    new MutationObserver(() => changes.push(status.textContent ?? "")).observe(status, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })
  await page.getByRole("button", { name: /Play motion/ }).click()
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 15000 })
  expect(requests).toHaveLength(1)
  const statuses = await page.evaluate(
    () => (window as unknown as { statusForTest: string[] }).statusForTest
  )
  expect(statuses).toContain("Preparing smooth motion…")
  expect(statuses.some((text) => /[0-9]+%/.test(text))).toBe(false)
  const blob = await page.locator("[data-world-video]").getAttribute("src")
  await page.locator("#faq").scrollIntoViewIfNeeded()
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await expect(world).not.toHaveAttribute("data-world-painted", "true")
  expect(
    await page.evaluate(() => (window as unknown as { revokedForTest: string[] }).revokedForTest)
  ).toContain(blob)
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
  await expect(world).toHaveAttribute("data-world-painted", "true", { timeout: 15000 })
  expect(requests).toHaveLength(2)
})

for (const preference of ["save-data", "reduced-motion"] as const) {
  test(`${preference} blocks even explicit play requests`, async ({ page }) => {
    await page.addInitScript(fastMotionConnection)
    if (preference === "save-data")
      await page.addInitScript(() =>
        Object.assign((navigator as Navigator & { connection: object }).connection, {
          saveData: true,
        })
      )
    else await page.emulateMedia({ reducedMotion: "reduce" })
    let requests = 0
    page.on("request", (request) => {
      if (request.url().endsWith("assurance-world.mp4")) requests++
    })
    await page.goto("/")
    await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "static")
    await expect(page.locator("[data-world-toggle]")).toBeDisabled()
    await page
      .locator("[data-world-toggle]")
      .evaluate((button) => button.dispatchEvent(new MouseEvent("click")))
    await page.waitForTimeout(300)
    expect(requests).toBe(0)
    await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  })
}

test("fast hints wait for window load and idle; leaving cancels queued idle work", async ({
  page,
}) => {
  await page.addInitScript(fastMotionConnection)
  await page.addInitScript(() => {
    const pending = new Map<number, IdleRequestCallback>()
    let next = 0
    const retired: IdleRequestCallback[] = []
    window.requestIdleCallback = (callback) => {
      pending.set(++next, callback)
      return next
    }
    window.cancelIdleCallback = (id) => {
      const callback = pending.get(id)
      if (callback) retired.push(callback)
      pending.delete(id)
    }
    Object.assign(window, {
      idleCountForTest: () => pending.size,
      runRetiredIdleForTest: () =>
        retired.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 50 })),
      runIdleForTest: () => {
        const callbacks = [...pending.values()]
        pending.clear()
        callbacks.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 50 }))
        return callbacks.length
      },
    })
  })
  let releaseImage!: () => void
  const held = new Promise<void>((resolve) => {
    releaseImage = resolve
  })
  await page.route("**/logo.svg", async (route) => {
    await held
    await route.continue()
  })
  let requests = 0
  page.on("request", (request) => {
    if (request.url().endsWith("assurance-world.mp4")) requests++
  })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const runIdle = () =>
    page.evaluate(() => (window as unknown as { runIdleForTest: () => number }).runIdleForTest())
  expect(await runIdle()).toBe(0)
  expect(requests).toBe(0)
  releaseImage()
  await page.waitForLoadState("load")
  expect(requests).toBe(0)
  await page.locator("#faq").scrollIntoViewIfNeeded()
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "poster")
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { idleCountForTest: () => number }).idleCountForTest()
      )
    )
    .toBe(0)
  expect(await runIdle()).toBe(0)
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
  await page.evaluate(() =>
    (window as unknown as { runRetiredIdleForTest: () => void }).runRetiredIdleForTest()
  )
  await expect.poll(runIdle).toBeGreaterThan(0)
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-painted", "true", {
    timeout: 15000,
  })
  expect(requests).toBe(1)
})

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`homepage actions and mobile navigation fit ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(unknownConnection)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/")
    await expect(page).toHaveTitle(/LyraShield AI/)
    await expect(page.locator("h1")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width
    )
    const primary = await page.locator(".premium-hero__primary").boundingBox()
    expect(primary && primary.x >= 0 && primary.x + primary.width <= viewport.width).toBe(true)
    if (viewport.width < 1024) {
      const motion = await page.locator("[data-world-toggle]").boundingBox()
      const title = await page.locator("h1").boundingBox()
      expect(motion && title && motion.y + motion.height <= title.y).toBe(true)
      await page.getByRole("button", { name: "Open navigation menu" }).click()
      const menu = page.getByRole("dialog", { name: "Mobile navigation" })
      await menu.getByText("Learn", { exact: true }).click()
      await menu.getByRole("link", { name: "Support", exact: true }).scrollIntoViewIfNeeded()
      const bounds = await menu.boundingBox()
      expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height).toBe(true)
      // WebKit's IntersectionObserver reports zero for nonmodal dialog descendants.
      const support = await menu.getByRole("link", { name: "Support", exact: true }).boundingBox()
      expect(support && support.y >= 0 && support.y + support.height <= viewport.height).toBe(true)
      await page.keyboard.press("Escape")
      await expect(menu).not.toBeVisible()
      await page.locator("#journey-report").scrollIntoViewIfNeeded()
      const rail = await page
        .getByRole("navigation", { name: "Evidence journey chapters" })
        .boundingBox()
      const control = await page.locator("[data-world-toggle]").boundingBox()
      expect(rail && control && rail.y + rail.height <= control.y).toBe(true)
    }
    await expect(page.locator("astro-error-overlay, #vite-error-overlay")).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("enlarged text and 200 percent CSS zoom retain usable navigation and actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(unknownConnection)
  await page.goto("/")
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2"
  })
  await expect(page.locator(".premium-hero__primary")).toBeVisible()
  const width = await page.evaluate(() => innerWidth)
  const primary = await page.locator(".premium-hero__primary").boundingBox()
  expect(primary && primary.x >= 0 && primary.x + primary.width <= width).toBe(true)
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1"
    document.documentElement.style.fontSize = "200%"
  })
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible()
  await page.getByRole("button", { name: "Open navigation menu" }).click()
  const menu = page.getByRole("dialog", { name: "Mobile navigation" })
  await menu.getByText("Learn", { exact: true }).click()
  await menu.getByRole("link", { name: "Support", exact: true }).scrollIntoViewIfNeeded()
  const bounds = await menu.boundingBox()
  expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900).toBe(true)
})

test("leaving during download aborts it and ignores its late response", async ({ page }) => {
  await page.addInitScript(fastMotionConnection)
  let requests = 0
  await page.route("**/assurance-world.mp4", async (route) => {
    requests++
    const response = await route.fetch()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fulfill({ response }).catch(() => {})
  })
  await page.goto("/")
  await expect(page.locator("[data-world-status]")).toHaveText("Preparing smooth motion…")
  await page.locator("#faq").scrollIntoViewIfNeeded()
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-state", "poster")
  await page.waitForTimeout(1200)
  await expect(page.locator("[data-world-video]")).not.toHaveAttribute("src", /.+/)
  await expect(page.locator("scroll-world")).not.toHaveAttribute("data-world-state", "fallback")
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
  await expect(page.locator("scroll-world")).toHaveAttribute("data-world-painted", "true", {
    timeout: 15000,
  })
  expect(requests).toBe(2)
})
