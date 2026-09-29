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
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
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
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
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

test("manual detail refresh supersedes a slow scheduled poll", async ({ page }) => {
  await page.clock.install()
  let requests = 0
  let releaseOld!: () => void
  const oldHeld = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  let oldHandled!: () => void
  const oldFinished = new Promise<void>((resolve) => {
    oldHandled = resolve
  })
  const headers: (string | null)[] = []
  await page.route("**/api/scans/scan-a?**", async (route) => {
    requests++
    headers.push(route.request().headers()["if-none-match"] ?? null)
    if (requests === 1) {
      await oldHeld
      try {
        await route.fulfill({
          headers: { ETag: '"old"' },
          json: { success: true, data: { ...pollDetail, status: "RUNNING" } },
        })
      } finally {
        oldHandled()
      }
    } else if (requests === 2) {
      await route.fulfill({
        headers: { ETag: '"new"' },
        json: { success: true, data: { ...pollDetail, status: "VERIFYING" } },
      })
    } else {
      await route.fulfill({ status: 304 })
    }
  })
  await page.goto("polling.html?polling=detail")
  await page.clock.runFor(5_000)
  await expect.poll(() => requests).toBe(1)
  await page.getByRole("button", { name: "Refresh now" }).click()
  await expect.poll(() => requests).toBe(2)
  await expect(page.getByRole("heading", { name: "Verifying evidence", exact: true })).toBeVisible()
  releaseOld()
  await oldFinished
  await page.clock.runFor(1)
  await expect(page.getByRole("heading", { name: "Verifying evidence", exact: true })).toBeVisible()
  await visibility(page, true)
  await visibility(page, false)
  await page.clock.runFor(1)
  await expect.poll(() => requests).toBeGreaterThanOrEqual(3)
  expect(headers.slice(2).every((header) => header === '"new"')).toBe(true)
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

test("filtered polling resets a loaded page cursor before loading again", async ({ page }) => {
  await page.clock.install()
  const cursors: (string | null)[] = []
  await page.route("**/api/scans?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    cursors.push(cursor)
    await route.fulfill({
      json: {
        success: true,
        data: cursor
          ? {
              items: [{ ...pollItem, id: cursor === "page-one" ? "scan-b" : "scan-c" }],
              nextCursor: cursor === "page-one" ? "page-two" : null,
            }
          : { items: [pollItem], nextCursor: "page-one" },
      },
    })
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("list", { name: "Scans" })).toContainText("scan-b")
  await page.clock.runFor(10_000)
  await expect(page.getByRole("listitem")).toHaveCount(1)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("listitem")).toHaveText(["scan-a", "scan-b"])
  expect(cursors).toEqual(["page-one", null, "page-one"])
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function fulfillPage(
  route: import("@playwright/test").Route,
  ids: string[],
  cursor: string | null,
  etag?: string
) {
  await route.fulfill({
    headers: etag ? { ETag: etag } : {},
    json: {
      success: true,
      data: { items: ids.map((id) => ({ ...pollItem, id })), nextCursor: cursor },
    },
  })
}

test("filtered poll invalidates an in-flight load-more response", async ({ page }) => {
  await page.clock.install()
  const held = gate()
  const finished = gate()
  let started = false
  await page.route("**/api/scans?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      started = true
      await held.promise
      await fulfillPage(route, ["stale-page"], "stale-cursor")
      finished.release()
    } else await fulfillPage(route, ["scan-a"], "fresh-cursor")
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect.poll(() => started).toBe(true)
  await page.clock.runFor(10_000)
  await expect(page.getByLabel("Cursor")).toHaveText("fresh-cursor")
  held.release()
  await finished.promise
  await expect(page.getByRole("listitem")).toHaveText(["scan-a"])
  await expect(page.getByLabel("Cursor")).toHaveText("fresh-cursor")
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled()
})

test("manual list refresh supersedes a slow poll and resets its ETag baseline", async ({
  page,
}) => {
  await page.clock.install()
  const held = gate()
  const finished = gate()
  const headers: (string | null)[] = []
  await page.route("**/api/scans?**", async (route) => {
    headers.push(route.request().headers()["if-none-match"] ?? null)
    if (headers.length === 1) await fulfillPage(route, ["scan-a"], "poll-cursor", '"baseline"')
    else if (headers.length === 2) {
      await held.promise
      await fulfillPage(route, ["old-poll"], "old-cursor", '"old"')
      finished.release()
    } else if (headers.length === 3) await fulfillPage(route, ["manual-page"], "manual-cursor")
    else if (headers.length === 4)
      await fulfillPage(route, ["manual-page"], "manual-cursor", '"fresh"')
    else await route.fulfill({ status: 304 })
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.clock.runFor(10_000)
  await expect(page.getByLabel("Cursor")).toHaveText("poll-cursor")
  await page.clock.runFor(10_000)
  await expect.poll(() => headers.length).toBe(2)
  await page.getByRole("button", { name: "Refresh list" }).click()
  await expect(page.getByRole("listitem")).toHaveText(["manual-page"])
  held.release()
  await finished.promise
  await expect(page.getByRole("listitem")).toHaveText(["manual-page"])
  await expect(page.getByLabel("Cursor")).toHaveText("manual-cursor")
  await page.clock.runFor(10_000)
  await expect.poll(() => headers.length).toBe(4)
  await page.clock.runFor(10_000)
  await expect.poll(() => headers.length).toBe(5)
  expect(headers).toEqual([null, '"baseline"', null, null, '"fresh"'])
  await expect(page.getByLabel("Cursor")).toHaveText("manual-cursor")
})

test("an unchanged filtered 304 preserves loaded rows and their cursor", async ({ page }) => {
  await page.clock.install()
  let requests = 0
  await page.route("**/api/scans?**", async (route) => {
    requests++
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    if (cursor) await fulfillPage(route, ["scan-a", "scan-b", "scan-b"], "page-two")
    else if (requests === 1) await fulfillPage(route, ["scan-a"], "page-one", '"same"')
    else {
      expect(route.request().headers()["if-none-match"]).toBe('"same"')
      await route.fulfill({ status: 304 })
    }
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.clock.runFor(10_000)
  await expect.poll(() => requests).toBe(1)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("listitem")).toHaveText(["scan-a", "scan-b"])
  await page.clock.runFor(10_000)
  await expect.poll(() => requests).toBe(3)
  await expect(page.getByRole("listitem")).toHaveText(["scan-a", "scan-b"])
  await expect(page.getByLabel("Cursor")).toHaveText("page-two")
})

for (const change of ["Completed filter", "Switch workspace"] as const) {
  test(`a late load-more response cannot replace ${change}`, async ({ page }) => {
    await page.clock.install()
    const held = gate()
    const finished = gate()
    let started = false
    await page.route("**/api/scans?**", async (route) => {
      const params = new URL(route.request().url()).searchParams
      if (params.has("cursor")) {
        started = true
        await held.promise
        await fulfillPage(route, ["stale-page"], "stale-cursor")
        finished.release()
      } else await fulfillPage(route, ["new-query"], "new-cursor")
    })
    await page.goto("polling.html?polling=list&filtered=1")
    await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
    await page.getByRole("button", { name: "Load more" }).click()
    await expect.poll(() => started).toBe(true)
    await page.getByRole("button", { name: change }).click()
    if (change === "Switch workspace") await page.clock.runFor(10_000)
    await expect(page.getByRole("listitem")).toHaveText(["new-query"])
    held.release()
    await finished.promise
    await expect(page.getByRole("listitem")).toHaveText(["new-query"])
    await expect(page.getByLabel("Cursor")).toHaveText("new-cursor")
  })
}

test("active filtering removes terminal rows when polling resumes after hiding", async ({
  page,
}) => {
  await page.clock.install()
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => (window as unknown as { testHidden: boolean }).testHidden ?? false,
    })
  })
  let requests = 0
  await page.route("**/api/scans?**", async (route) => {
    requests++
    await fulfillPage(route, [], null)
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await expect(page.getByRole("listitem")).toHaveCount(1)
  await visibility(page, true)
  await page.clock.runFor(60_000)
  expect(requests).toBe(0)
  await visibility(page, false)
  await page.clock.runFor(1)
  await expect(page.getByRole("listitem")).toHaveCount(0)
  await expect(page.getByLabel("Cursor")).toHaveText("end")
  await page.clock.runFor(60_000)
  expect(requests).toBe(1)
})

for (const action of ["Cancel scan", "Remove scan"] as const) {
  test(`${action} prevents an older poll from resurrecting its row`, async ({ page }) => {
    await page.clock.install()
    const held = gate()
    const finished = gate()
    let started = false
    await page.route("**/api/scans?**", async (route) => {
      started = true
      await held.promise
      await fulfillPage(route, ["scan-a"], "old-cursor")
      finished.release()
    })
    await page.route("**/api/scans/scan-a**", async (route) => {
      await route.fulfill({
        json: {
          success: true,
          data:
            action === "Cancel scan"
              ? { id: "scan-a", status: "CANCELLED", endedAt: startedAt }
              : null,
        },
      })
    })
    await page.goto("polling.html?polling=list&filtered=1")
    await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
    await page.clock.runFor(10_000)
    await expect.poll(() => started).toBe(true)
    await page.getByRole("button", { name: action }).click()
    await expect(page.getByRole("listitem")).toHaveCount(0)
    held.release()
    await finished.promise
    await expect(page.getByRole("listitem")).toHaveCount(0)
  })
}

test("unmount stops polling and ignores a late page response", async ({ page }) => {
  await page.clock.install()
  const held = gate()
  let requests = 0
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/scans?**", async (route) => {
    requests++
    await held.promise
    await fulfillPage(route, ["late"], null)
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect.poll(() => requests).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event("test:unmount")))
  held.release()
  await page.clock.runFor(70_000)
  await expect(page.locator("#root")).toBeEmpty()
  expect(requests).toBe(1)
  expect(errors).toEqual([])
})

test("polling waits for an in-flight manual first page", async ({ page }) => {
  await page.clock.install()
  const held = gate()
  let requests = 0
  await page.route("**/api/scans?**", async (route) => {
    requests++
    await held.promise
    await fulfillPage(route, ["manual"], "manual-cursor")
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Refresh list" }).click()
  await expect.poll(() => requests).toBe(1)
  await page.clock.runFor(20_000)
  expect(requests).toBe(1)
  held.release()
  await expect(page.getByRole("listitem")).toHaveText(["manual"])
  await expect(page.getByLabel("Cursor")).toHaveText("manual-cursor")
})

test("unfiltered polling preserves loaded pages while resolving off-page active rows", async ({
  page,
}) => {
  await page.clock.install()
  const params: string[] = []
  await page.route("**/api/scans?**", async (route) => {
    const query = new URL(route.request().url()).searchParams
    params.push(query.toString())
    if (query.has("cursor")) await fulfillPage(route, ["scan-b"], "page-two")
    else if (query.has("ids"))
      await route.fulfill({
        json: {
          success: true,
          data: {
            items: [
              { ...pollItem, status: "COMPLETED" },
              { ...pollItem, id: "scan-b" },
            ],
            nextCursor: null,
          },
        },
      })
    else await fulfillPage(route, ["scan-new"], "new-page-one")
  })
  await page.goto("polling.html?polling=list")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("listitem")).toHaveText(["scan-a", "scan-b"])
  await page.clock.runFor(10_000)
  await expect(page.getByRole("listitem")).toHaveText(["scan-new", "scan-a", "scan-b"])
  await expect(page.getByRole("status")).toContainText("VERIFYING,COMPLETED,VERIFYING")
  await expect(page.getByLabel("Cursor")).toHaveText("page-two")
  expect(params).toContain("workspaceId=ws-a&ids=scan-a%2Cscan-b")
})

test("a late poll and its failure cannot overwrite a changed filter", async ({ page }) => {
  await page.clock.install()
  const held = gate()
  const finished = gate()
  let started = false
  await page.route("**/api/scans?**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state")
    if (state === "ACTIVE") {
      started = true
      await held.promise
      try {
        await route.fulfill({
          status: 503,
          json: { success: false, error: { message: "Old filter failed", code: "FAILED" } },
        })
      } finally {
        finished.release()
      }
    } else
      await route.fulfill({
        json: {
          success: true,
          data: {
            items: [{ ...pollItem, id: "complete", status: "COMPLETED" }],
            nextCursor: "completed-cursor",
          },
        },
      })
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.clock.runFor(10_000)
  await expect.poll(() => started).toBe(true)
  await page.getByRole("button", { name: "Completed filter" }).click()
  await expect(page.getByRole("listitem")).toHaveText(["complete"])
  held.release()
  await finished.promise
  await expect(page.getByLabel("Cursor")).toHaveText("completed-cursor")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("late cancellation cannot change the new workspace snapshot", async ({ page }) => {
  const held = gate()
  const finished = gate()
  let started = false
  await page.route("**/api/scans/scan-a", async (route) => {
    started = true
    await held.promise
    await route.fulfill({
      json: { success: true, data: { id: "scan-a", status: "CANCELLED", endedAt: startedAt } },
    })
    finished.release()
  })
  await page.goto("polling.html?polling=list&filtered=1")
  await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible()
  await page.getByRole("button", { name: "Cancel scan" }).click()
  await expect.poll(() => started).toBe(true)
  await page.getByRole("button", { name: "Switch workspace" }).click()
  held.release()
  await finished.promise
  await expect(page.getByRole("status")).toHaveText("ws-b: RUNNING")
  await expect(page.getByRole("listitem")).toHaveText(["scan-a"])
})

test("a complete unfiltered first page clears a formerly loaded continuation", async ({ page }) => {
  await page.clock.install()
  await page.route("**/api/scans?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    await fulfillPage(route, cursor ? ["scan-b"] : ["scan-a", "scan-b"], cursor ? "page-two" : null)
  })
  await page.goto("polling.html?polling=list")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByLabel("Cursor")).toHaveText("page-two")
  await page.clock.runFor(10_000)
  await expect(page.getByLabel("Cursor")).toHaveText("end")
  await expect(page.getByRole("listitem")).toHaveText(["scan-a", "scan-b"])
  await expect(page.getByRole("button", { name: "Load more" })).toBeDisabled()
})
