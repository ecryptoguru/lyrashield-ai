import { expect, test, type Page } from "@playwright/test"

const startedAt = "2026-09-19T10:00:00.000Z"
const pollItem = {
  id: "scan-a",
  status: "VERIFYING",
  goal: "TEST_APP",
  mode: "STANDARD",
  triggerType: "manual",
  startedAt,
  endedAt: null,
  summary: null,
  errorCategory: null,
  errorMessage: null,
  target: null,
  createdAt: startedAt,
}
const pollDetail = {
  ...pollItem,
  workspaceId: "ws-a",
  events: [],
}

async function visibility(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    ;(window as unknown as { testHidden: boolean }).testHidden = value
    document.dispatchEvent(new Event("visibilitychange"))
  }, hidden)
}

for (const view of ["list", "detail"] as const) {
  test(`${view} coalesces visibility restoration around a slow poll`, async ({ page }) => {
    await page.clock.install()
    await page.addInitScript(() => {
      ;(window as unknown as { testHidden: boolean }).testHidden = false
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => (window as unknown as { testHidden: boolean }).testHidden,
      })
    })
    let requests = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(
      view === "list" ? "**/api/scans?**" : "**/api/scans/scan-a?**",
      async (route) => {
        requests++
        await held
        await route.fulfill({
          json:
            view === "list"
              ? { success: true, data: { items: [pollItem], nextCursor: null } }
              : { success: true, data: pollDetail },
        })
      }
    )
    await page.goto(`polling.html?polling=${view}`)
    await expect(
      page.getByRole("button", { name: view === "list" ? "Switch workspace" : "Switch scan" })
    ).toBeVisible()
    await page.clock.runFor(view === "list" ? 10_000 : 5_000)
    await expect.poll(() => requests).toBe(1)
    for (let i = 0; i < 3; i++) {
      await visibility(page, true)
      await visibility(page, false)
      await page.clock.fastForward(1)
    }
    expect(requests).toBe(1)
    await visibility(page, true)
    release()
    if (view === "list") await expect(page.getByRole("status")).toContainText("VERIFYING")
    await page.clock.fastForward(70_000)
    expect(requests).toBe(1)
    await visibility(page, false)
    await page.clock.fastForward(1)
    await expect.poll(() => requests).toBe(2)
  })
}

test("a late list response cannot replace the new workspace", async ({ page }) => {
  await page.clock.install()
  let releaseOld!: () => void
  const oldHeld = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  let oldStarted!: () => void
  const oldRequest = new Promise<void>((resolve) => {
    oldStarted = resolve
  })
  await page.route("**/api/scans?**", async (route) => {
    const workspace = new URL(route.request().url()).searchParams.get("workspaceId")
    if (workspace === "ws-a") {
      oldStarted()
      await oldHeld
      await route.fulfill({
        json: {
          success: true,
          data: { items: [{ ...pollItem, status: "COMPLETED" }], nextCursor: null },
        },
      })
    } else {
      await route.fulfill({
        json: { success: true, data: { items: [pollItem], nextCursor: null } },
      })
    }
  })
  await page.goto("polling.html?polling=list")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toBeVisible()
  await page.clock.runFor(10_000)
  await oldRequest
  await page.getByRole("button", { name: "Switch workspace" }).click()
  await page.clock.runFor(10_000)
  await expect(page.getByRole("status")).toContainText("ws-b: VERIFYING")
  releaseOld()
  await expect(page.getByRole("status")).toContainText("ws-b: VERIFYING")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("list polling reuses its ETag after a successful response", async ({ page }) => {
  await page.clock.install()
  const headers: (string | null)[] = []
  await page.route("**/api/scans?**", async (route) => {
    headers.push(route.request().headers()["if-none-match"] ?? null)
    if (headers.length === 1) {
      await route.fulfill({
        headers: { ETag: '"scan-list-1"' },
        json: { success: true, data: { items: [pollItem], nextCursor: null } },
      })
    } else {
      await route.fulfill({ status: 304 })
    }
  })
  await page.goto("polling.html?polling=list")
  await expect(page.getByRole("button", { name: "Switch workspace" })).toBeVisible()
  await page.clock.runFor(10_000)
  await expect(page.getByRole("status")).toContainText("VERIFYING")
  await visibility(page, true)
  await visibility(page, false)
  await page.clock.runFor(1)
  await expect.poll(() => headers.length).toBeGreaterThanOrEqual(2)
  expect(headers[0]).toBeNull()
  expect(headers.slice(1).every((header) => header === '"scan-list-1"')).toBe(true)
})

for (const width of [390, 768, 1440]) {
  test(`scan detail remains usable without overflow at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    let refreshes = 0
    await page.route("**/api/scans/scan-a?**", async (route) => {
      refreshes++
      await route.fulfill({ json: { success: true, data: pollDetail } })
    })
    await page.setViewportSize({ width, height: 900 })
    await page.goto("polling.html?polling=detail")
    const refresh = page.getByRole("button", { name: "Refresh now" })
    await refresh.focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => refreshes).toBe(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
