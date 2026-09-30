import { expect, test, type Page } from "@playwright/test"

async function composerRoutes(page: Page) {
  await page.route("**/api/scans/eligibility?**", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          allowed: true,
          code: null,
          message: null,
          plan: "STARTER",
          isTrial: false,
          remainingMinutes: 100,
        },
      },
    })
  )
  await page.route("**/api/scans/attachments?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [] } } })
  )
}

for (const width of [390, 768, 1440]) {
  test(`scan composer keeps keyboard selection and returns focus at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await composerRoutes(page)
    await page.goto("polling.html?polling=create")
    const open = page.getByRole("button", { name: /^New scan$/i })
    await open.focus()
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Start a scan" })
    await expect(dialog).toBeVisible()
    expect(
      await dialog.evaluate((element) => parseFloat(getComputedStyle(element).animationDuration))
    ).toBeLessThanOrEqual(0.00001)
    await dialog.getByRole("button", { name: "Close", exact: true }).focus()
    await page.keyboard.press("Tab")
    await expect(dialog.getByLabel("Target", { exact: true })).toBeFocused()
    await expect(dialog.getByLabel("Target", { exact: true })).toHaveValue("target-a")
    const selected = dialog.locator('[role="radio"][aria-checked="true"]')
    const oldId = await selected.getAttribute("id")
    await selected.focus()
    await page.keyboard.press("ArrowDown")
    await expect(selected).toBeFocused()
    expect(await selected.getAttribute("id")).not.toBe(oldId)
    await page.keyboard.press("ArrowUp")
    expect(await selected.getAttribute("id")).toBe(oldId)
    await expect(dialog.getByRole("button", { name: /^Start scan$/i })).toBeEnabled()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await page.screenshot({ path: `test-results/scan-composer-${width}.png` })
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(open).toBeFocused()
    expect(errors).toEqual([])
  })
}

test("recoverable start errors keep revisions and retry the same submission once", async ({
  page,
}) => {
  await composerRoutes(page)
  const requests: { body: unknown; key: string | undefined }[] = []
  await page.route("**/api/scans", async (route) => {
    requests.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    })
    await route.fulfill({
      status: 503,
      json: {
        success: false,
        error: {
          code: "WORKER_UNAVAILABLE",
          message: "Scan service is temporarily unavailable. Try again.",
        },
      },
    })
  })
  await page.goto("polling.html?polling=create")
  await page.getByRole("button", { name: /^New scan$/i }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("radio", { name: /^Scan changes:/ }).click()
  await dialog.getByLabel(/^Base revision/).fill("release-branch")
  await dialog.getByLabel(/^Head revision/).fill("feature-branch")
  const submit = dialog.getByRole("button", { name: /^Start scan$/i })
  await expect(submit).toBeEnabled()
  await submit.click()
  const alert = dialog.getByRole("alert")
  await expect(alert).toHaveText("Scan service is temporarily unavailable. Try again.")
  await expect(dialog.getByLabel(/^Base revision/)).toHaveValue("release-branch")
  await expect(dialog.getByLabel(/^Head revision/)).toHaveValue("feature-branch")
  await expect(submit).toBeEnabled()
  await submit.focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[0]?.key).toBeTruthy()
  expect(requests[1]).toEqual(requests[0])
})

test("accepted recovery remains available without submitting another scan", async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "lyrashield:scan-submission:v1:user-a:ws-a:dashboard",
      JSON.stringify({
        version: 1,
        principalId: "user-a",
        workspaceId: "ws-a",
        surface: "dashboard",
        requestIdentity: "{}",
        idempotencyKey: "12345678-1234-4234-9234-123456789abc",
        state: "accepted",
        scanId: "accepted-scan",
      })
    )
  )
  let creates = 0
  await page.route("**/api/scans", async (route) => {
    creates++
    await route.abort()
  })
  await page.goto("polling.html?polling=create")
  await expect(page.getByRole("status")).toContainText("Scan accepted.")
  await expect(page.getByRole("link", { name: "View scan" })).toHaveAttribute(
    "href",
    "/dashboard/scans/accepted-scan"
  )
  expect(creates).toBe(0)
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")!)
          .state
    )
  ).toBe("accepted")
})

test("the real list announces the first-page reset and keeps filters truthful", async ({
  page,
}) => {
  await page.clock.install()
  await page.route("**/api/scans?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    await route.fulfill({
      json: {
        success: true,
        data: {
          items: [
            {
              id: cursor ? "scan-b" : "scan-a",
              status: "RUNNING",
              goal: "TEST_APP",
              mode: "STANDARD",
              triggerType: "manual",
              startedAt: null,
              endedAt: null,
              summary: null,
              errorCategory: null,
              errorMessage: null,
              target: null,
              createdAt: "2026-09-19T10:00:00.000Z",
            },
          ],
          nextCursor: cursor ? "page-two" : "page-one",
        },
      },
    })
  })
  await page.goto("polling.html?polling=client-list&recovered=1")
  await expect(page.getByRole("status")).toHaveText(
    "This target filter is no longer available. Showing all targets with your selected state."
  )
  await expect(page.getByLabel("Filter by state")).toHaveValue("ACTIVE")
  await expect(page.getByLabel("Filter by target")).toHaveValue("")
  await page.getByRole("button", { name: "Load More", exact: true }).click()
  await expect(page.getByRole("link", { name: "Workspace scan", exact: true })).toHaveCount(2)
  await page.clock.runFor(10_000)
  await expect(page.getByRole("status").filter({ hasText: "Scan updates refreshed" })).toHaveText(
    "Scan updates refreshed the first page. Load more to see older scans."
  )
  await expect(page.getByRole("link", { name: "Workspace scan", exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Load More", exact: true })).toBeEnabled()
})

test("unresolved operation recovery checks the existing scan without resubmitting", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "lyrashield:scan-submission:v1:user-a:ws-a:dashboard",
      JSON.stringify({
        version: 1,
        principalId: "user-a",
        workspaceId: "ws-a",
        surface: "dashboard",
        requestIdentity: "{}",
        idempotencyKey: "12345678-1234-4234-9234-123456789abc",
        state: "pending",
        operationId: "operation-1",
      })
    )
  )
  let creates = 0
  let checks = 0
  await page.route("**/api/scans", async (route) => {
    creates++
    await route.abort()
  })
  await page.route("**/api/agent-operations/operation-1?**", async (route) => {
    checks++
    await route.fulfill({
      json: {
        success: true,
        data: {
          operationId: "operation-1",
          status: "EXECUTING",
          reasonCode: null,
          resultLocation: null,
          recovery: "poll",
          createdAt: "2026-09-19T10:00:00.000Z",
          updatedAt: "2026-09-19T10:00:00.000Z",
        },
      },
    })
  })
  await page.goto("polling.html?polling=create")
  const check = page.getByRole("button", { name: "Check previous scan", exact: true })
  await check.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toContainText("The scan operation is still processing.")
  expect(checks).toBe(1)
  expect(creates).toBe(0)
  await page.screenshot({ path: "test-results/scan-operation-recovery.png" })
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")!)
          .operationId
    )
  ).toBe("operation-1")
})

for (const [action, read] of [
  ["cancellation", "manual refresh"],
  ["removal", "manual refresh"],
  ["creation", "manual refresh"],
  ["creation", "target filter"],
] as const) {
  test(`accepted ${action} releases a superseded ${read}`, async ({ page }) => {
    let release!: () => void
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    let refreshStarted = false
    const scan = {
      id: "created-scan",
      status: "QUEUED",
      goal: "TEST_APP",
      mode: "STANDARD",
      triggerType: "MANUAL",
      startedAt: null,
      endedAt: null,
      summary: null,
      errorCategory: null,
      errorMessage: null,
      target: {
        id: "target-a",
        name: "Example repository",
        type: "REPO",
        url: null,
        apiSpecUrl: null,
        repoFullName: "example/repository",
      },
      createdAt: "2026-09-19T10:00:00.000Z",
    }
    await composerRoutes(page)
    await page.route("**/api/scans?**", async (route) => {
      refreshStarted = true
      await held
      await route.fulfill({
        json: {
          success: true,
          data: { items: [{ ...scan, id: "stale-read" }], nextCursor: "stale-cursor" },
        },
      })
      finish()
    })
    await page.route("**/api/scans/scan-a**", async (route) => {
      await route.fulfill({
        json: {
          success: true,
          data:
            action === "cancellation"
              ? { id: "scan-a", status: "CANCELLED", endedAt: scan.createdAt }
              : { id: "scan-a" },
        },
      })
    })
    await page.route("**/api/scans", async (route) =>
      route.fulfill({ json: { success: true, data: scan } })
    )
    await page.goto(`polling.html?polling=${action === "cancellation" ? "client-list" : "create"}`)
    const refresh = page.getByRole("button", { name: "Refresh", exact: true })
    if (read === "target filter") await page.getByLabel("Filter by target").selectOption("target-a")
    else await refresh.click()
    await expect.poll(() => refreshStarted).toBe(true)
    await expect(refresh).toBeDisabled()

    if (action === "cancellation") {
      await page.getByRole("button", { name: "Cancel this scan", exact: true }).click()
      await page.getByRole("button", { name: "Stop scan", exact: true }).click()
      await expect(page.getByRole("link", { name: "Workspace scan", exact: true })).toHaveCount(0)
    } else if (action === "removal") {
      await page.getByRole("button", { name: "Remove scan", exact: true }).click()
      await page.getByRole("button", { name: "Remove", exact: true }).click()
      await expect(page.getByRole("link", { name: "Workspace scan", exact: true })).toHaveCount(0)
    } else {
      await page.getByRole("button", { name: /^New scan$/i }).click()
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Start scan$/i })
        .click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.locator('a[href="/dashboard/scans/created-scan"]').first()).toBeVisible()
    }

    await expect(refresh).toBeEnabled()
    await expect(page.getByLabel("Loading scans")).toHaveCount(0)
    release()
    await finished
    await expect(refresh).toBeEnabled()
    await expect(page.getByLabel("Loading scans")).toHaveCount(0)
    await expect(page.locator('a[href="/dashboard/scans/stale-read"]')).toHaveCount(0)
  })
}

function responseGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const lateAcceptedScan = {
  id: "accepted-in-old-scope",
  status: "QUEUED",
  goal: "TEST_APP",
  mode: "STANDARD",
  triggerType: "MANUAL",
  startedAt: null,
  endedAt: null,
  summary: null,
  errorCategory: null,
  errorMessage: null,
  target: {
    id: "target-a",
    name: "Example repository",
    type: "REPO",
    url: null,
    apiSpecUrl: null,
    repoFullName: "example/repository",
  },
  createdAt: "2026-09-19T10:00:00.000Z",
}

for (const change of ["workspace", "principal"] as const) {
  test(`late accepted creation stays recoverable in its original scope after a ${change} change`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await composerRoutes(page)
    await page.route("**/api/scans?**", (route) =>
      route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
    )
    const held = responseGate()
    const finished = responseGate()
    let started = false
    await page.route("**/api/scans", async (route) => {
      started = true
      await held.promise
      await route.fulfill({ json: { success: true, data: lateAcceptedScan } })
      finished.release()
    })
    await page.goto("polling.html?polling=scope")
    await page.getByRole("button", { name: /^New scan$/i }).click()
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Start scan$/i })
      .click()
    await expect.poll(() => started).toBe(true)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.getByRole("button", { name: `Switch ${change}`, exact: true }).click()
    await expect(page.getByLabel("Current scope")).toHaveText(
      change === "workspace" ? "user-a:ws-b" : "user-b:ws-a"
    )
    await page.getByRole("button", { name: /^New scan$/i }).click()
    const dialog = page.getByRole("dialog")
    await dialog
      .getByLabel("Target", { exact: true })
      .selectOption(change === "workspace" ? "target-b" : "target-a")
    await dialog.getByRole("radio", { name: /^Scan changes:/ }).click()
    await dialog.getByLabel(/^Base revision/).fill("new-scope-base")
    await dialog.getByLabel(/^Head revision/).fill("new-scope-head")
    held.release()
    await finished.promise
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const stored = sessionStorage.getItem(
            "lyrashield:scan-submission:v1:user-a:ws-a:dashboard"
          )
          return stored ? JSON.parse(stored).state : null
        })
      )
      .toBe("accepted")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel(/^Base revision/)).toHaveValue("new-scope-base")
    await expect(dialog.getByLabel(/^Head revision/)).toHaveValue("new-scope-head")
    await expect(page.locator('a[href="/dashboard/scans/accepted-in-old-scope"]')).toHaveCount(0)
    if (change === "workspace") {
      await page.screenshot({ path: "test-results/scan-late-workspace-acceptance.png" })
    }
    expect(
      await page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")!)
            .scanId
      )
    ).toBe("accepted-in-old-scope")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: `Switch ${change}`, exact: true }).click()
    await expect(page.getByLabel("Current scope")).toHaveText("user-a:ws-a")
    await expect(page.getByRole("link", { name: "View scan", exact: true })).toHaveAttribute(
      "href",
      "/dashboard/scans/accepted-in-old-scope"
    )
  })

  test(`late operation completion preserves original recovery without replacing the ${change} scope check`, async ({
    page,
  }) => {
    await page.addInitScript((change) => {
      const original = {
        version: 1,
        principalId: "user-a",
        workspaceId: "ws-a",
        surface: "dashboard",
        requestIdentity: "{}",
        idempotencyKey: "12345678-1234-4234-9234-123456789abc",
        state: "pending",
        operationId: "operation-a",
      }
      sessionStorage.setItem(
        "lyrashield:scan-submission:v1:user-a:ws-a:dashboard",
        JSON.stringify(original)
      )
      const principalId = change === "principal" ? "user-b" : "user-a"
      const workspaceId = change === "workspace" ? "ws-b" : "ws-a"
      sessionStorage.setItem(
        `lyrashield:scan-submission:v1:${principalId}:${workspaceId}:dashboard`,
        JSON.stringify({ ...original, principalId, workspaceId, operationId: "operation-b" })
      )
    }, change)
    const oldHeld = responseGate()
    const newHeld = responseGate()
    const oldFinished = responseGate()
    const started: string[] = []
    await page.route("**/api/agent-operations/**", async (route) => {
      const old = new URL(route.request().url()).pathname.endsWith("operation-a")
      started.push(old ? "old" : "new")
      await (old ? oldHeld.promise : newHeld.promise)
      await route.fulfill({
        json: {
          success: true,
          data: {
            operationId: old ? "operation-a" : "operation-b",
            status: old ? "COMPLETED" : "EXECUTING",
            reasonCode: null,
            resultLocation: old ? "accepted-in-old-scope" : null,
            recovery: old ? "none" : "poll",
            createdAt: lateAcceptedScan.createdAt,
            updatedAt: lateAcceptedScan.createdAt,
          },
        },
      })
      if (old) oldFinished.release()
    })
    await page.goto("polling.html?polling=scope")
    await page.getByRole("button", { name: "Check previous scan", exact: true }).click()
    await expect.poll(() => started).toEqual(["old"])
    await page.getByRole("button", { name: `Switch ${change}`, exact: true }).click()
    await page.getByRole("button", { name: "Check previous scan", exact: true }).click()
    await expect.poll(() => started).toEqual(["old", "new"])
    oldHeld.release()
    await oldFinished.promise
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(
              sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")!
            ).state
        )
      )
      .toBe("accepted")
    await expect(page.getByRole("button", { name: "Checking status…", exact: true })).toBeDisabled()
    await expect(page.getByRole("link", { name: "View scan", exact: true })).toHaveCount(0)
    newHeld.release()
    await expect(page.getByRole("alert")).toContainText("The scan operation is still processing.")
  })
}

test("late acceptance cannot unlock or reset a new workspace submission", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await composerRoutes(page)
  await page.route("**/api/scans?**", (route) =>
    route.fulfill({ json: { success: true, data: { items: [], nextCursor: null } } })
  )
  const oldHeld = responseGate()
  const newHeld = responseGate()
  const requests: string[] = []
  await page.route("**/api/scans", async (route) => {
    const workspace = route.request().postDataJSON().workspaceId as string
    requests.push(workspace)
    await (workspace === "ws-a" ? oldHeld.promise : newHeld.promise)
    await route.fulfill({
      json: {
        success: true,
        data: {
          ...lateAcceptedScan,
          id: workspace === "ws-a" ? "accepted-in-old-scope" : "accepted-in-new-scope",
          target: {
            ...lateAcceptedScan.target,
            id: workspace === "ws-a" ? "target-a" : "target-b",
          },
        },
      },
    })
  })
  await page.goto("polling.html?polling=scope")
  await page.getByRole("button", { name: /^New scan$/i }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Start scan$/i })
    .click()
  await expect.poll(() => requests).toEqual(["ws-a"])
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Switch workspace", exact: true }).click()
  await page.getByRole("button", { name: /^New scan$/i }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Target", { exact: true }).selectOption("target-b")
  await dialog.getByRole("button", { name: /^Start scan$/i }).click()
  await expect.poll(() => requests).toEqual(["ws-a", "ws-b"])
  oldHeld.release()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")
        return stored ? JSON.parse(stored).state : null
      })
    )
    .toBe("accepted")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled()
  await expect(page.locator('a[href="/dashboard/scans/accepted-in-old-scope"]')).toHaveCount(0)
  newHeld.release()
  await expect(dialog).toHaveCount(0)
  await expect(
    page.locator('a[href="/dashboard/scans/accepted-in-new-scope"]').first()
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-b:dashboard")
    )
  ).toBeNull()
})

test("accepted creation after unmount remains saved for original scope recovery", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await composerRoutes(page)
  const held = responseGate()
  let started = false
  await page.route("**/api/scans", async (route) => {
    started = true
    await held.promise
    await route.fulfill({ json: { success: true, data: lateAcceptedScan } })
  })
  await page.goto("polling.html?polling=scope")
  await page.getByRole("button", { name: /^New scan$/i }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Start scan$/i })
    .click()
  await expect.poll(() => started).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new Event("test:unmount")))
  await expect(page.getByRole("dialog")).toHaveCount(0)
  held.release()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")
        return stored ? JSON.parse(stored).scanId : null
      })
    )
    .toBe("accepted-in-old-scope")
})

test("late ambiguous creation saves its original operation without showing a new scope error", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await composerRoutes(page)
  const held = responseGate()
  let started = false
  await page.route("**/api/scans", async (route) => {
    started = true
    await held.promise
    await route.fulfill({
      status: 503,
      json: {
        success: false,
        error: {
          code: "WORKER_UNAVAILABLE",
          message: "Check the original operation before retrying.",
          details: { operationId: "original-operation" },
        },
      },
    })
  })
  await page.goto("polling.html?polling=scope")
  await page.getByRole("button", { name: /^New scan$/i }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Start scan$/i })
    .click()
  await expect.poll(() => started).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Switch workspace", exact: true }).click()
  held.release()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-a:dashboard")
        return stored ? JSON.parse(stored).operationId : null
      })
    )
    .toBe("original-operation")
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("lyrashield:scan-submission:v1:user-a:ws-b:dashboard")
    )
  ).toBeNull()
})
