import { expect, test } from "@playwright/test"

function finding(id: string, title: string, status = "OPEN") {
  return {
    id,
    title,
    summary: title,
    severity: "HIGH",
    status,
    verified: false,
    verificationStatus: "NOT_VERIFIED",
    confidence: "medium",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  }
}

function pageOf(id: string, title: string, status = "OPEN", nextCursor: string | null = null) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      success: true,
      data: { items: [finding(id, title, status)], nextCursor },
    }),
  }
}

test("clearing search restores the current unfiltered page and URL", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const requests: string[] = []
  await page.route("**/api/findings?**", (route) => {
    requests.push(route.request().url())
    const q = new URL(route.request().url()).searchParams.get("q")
    return route.fulfill(
      q ? pageOf("search", "Search finding") : pageOf("initial", "Initial finding")
    )
  })
  await page.goto("?findings")
  const search = page.getByRole("searchbox", { name: "Search findings" })
  await search.fill("missing")
  await expect(page).toHaveURL(/q=missing/)
  await expect(page.getByRole("button", { name: /Search finding/ })).toBeVisible()
  await search.fill("")
  await expect(page).not.toHaveURL(/q=/)
  await expect(page.getByRole("button", { name: /Initial finding/ })).toBeVisible()
  expect(new URL(requests.at(-1)!).searchParams.has("q")).toBe(false)
})

test("returning to Open waits for its own response instead of accepting an old All response", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let releaseAll: (() => void) | undefined
  await page.route("**/api/findings?**", async (route) => {
    const status = new URL(route.request().url()).searchParams.get("status")
    if (!status) {
      await new Promise<void>((resolve) => {
        releaseAll = resolve
      })
      await route.fulfill(pageOf("all", "All finding")).catch(() => {})
    } else {
      await route.fulfill(pageOf("open", "Open finding"))
    }
  })
  await page.goto("?findings")
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("ALL")
  await expect.poll(() => Boolean(releaseAll)).toBe(true)
  await page.getByRole("combobox", { name: "Filter by status" }).selectOption("OPEN")
  await expect(page.getByRole("button", { name: /Open finding/ })).toBeVisible()
  releaseAll?.()
  await expect(page.getByRole("button", { name: /Open finding/ })).toBeEnabled()
  await expect(page.getByRole("button", { name: /All finding/ })).toHaveCount(0)
  await expect(page).not.toHaveURL(/filter=ALL/)
})

test("target and Back keep URL, control and rows aligned", async ({ page }) => {
  await page.route("**/api/findings?**", (route) => {
    const target = new URL(route.request().url()).searchParams.get("targetId")
    return route.fulfill(
      target ? pageOf("target", "Target finding") : pageOf("open", "Open finding")
    )
  })
  await page.goto("?findings")
  await page.getByRole("combobox", { name: "Filter by target" }).selectOption("target-test")
  await expect(page).toHaveURL(/target=target-test/)
  await expect(page.getByRole("button", { name: /Target finding/ })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("combobox", { name: "Filter by target" })).toHaveValue("")
  await expect(page.getByRole("button", { name: /Open finding/ })).toBeVisible()
})

test("Back through sort choices preserves loaded pages without refetching", async ({ page }) => {
  const requests: string[] = []
  await page.route("**/api/findings?**", (route) => {
    requests.push(route.request().url())
    return route.fulfill(pageOf("second", "Second finding"))
  })
  await page.goto("?findings&hasPages=1")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Second finding/ })).toBeVisible()
  const sort = page.getByRole("combobox", { name: "Sort loaded results" })
  await sort.selectOption("severity")
  await sort.selectOption("newest")
  await page.goBack()
  await expect(sort).toHaveValue("severity")
  await expect(page.getByRole("button", { name: /Second finding/ })).toBeVisible()
  await page.goForward()
  await expect(sort).toHaveValue("newest")
  await expect(page.getByRole("button", { name: /Second finding/ })).toBeVisible()
  expect(requests).toHaveLength(1)
})

test("failed current query can retry without resetting its filter", async ({ page }) => {
  let tries = 0
  await page.route("**/api/findings?**", (route) => {
    tries++
    return tries === 1 ? route.abort("failed") : route.fulfill(pageOf("retry", "Retried finding"))
  })
  await page.goto("?findings")
  await page.getByRole("combobox", { name: "Filter by severity" }).selectOption("HIGH")
  await expect(page.getByText(/Failed to load findings/)).toBeVisible()
  await page.getByRole("button", { name: /Retry/i }).click()
  await expect(page.getByRole("button", { name: /Retried finding/ })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Filter by severity" })).toHaveValue("HIGH")
})

test("reload revalidates saved additional pages before showing them", async ({ page }) => {
  let pageLoads = 0
  await page.route("**/api/findings?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    if (cursor === "cursor-1") {
      pageLoads++
      return route.fulfill(
        pageOf("second", pageLoads === 1 ? "Old second finding" : "Fresh second finding")
      )
    }
    return route.fulfill(pageOf("first", "Initial finding"))
  })
  await page.goto("?findings&hasPages=1")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Old second finding/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: /Fresh second finding/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Old second finding/ })).toHaveCount(0)
  expect(pageLoads).toBe(2)
})

test("observed-scan scope survives search, filters, Back, pagination, and reload", async ({
  page,
}) => {
  const requests: string[] = []
  let pageLoads = 0
  await page.route("**/api/findings?**", (route) => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    if (url.searchParams.has("cursor")) {
      pageLoads++
      return route.fulfill(
        pageOf("scoped-page", pageLoads === 1 ? "Loaded scoped page" : "Restored scoped page")
      )
    }
    const q = url.searchParams.get("q")
    const severity = url.searchParams.get("severity")
    return route.fulfill(
      q
        ? pageOf("search", "Search finding")
        : severity
          ? pageOf("high", "High finding")
          : pageOf("initial", "Initial finding", "OPEN", "cursor-1")
    )
  })

  await page.goto("?findings&hasPages=1&scanId=observed-scan&target=target-test")
  await expect(page.getByText("Target: Test target · Scan: observed-scan")).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Filter by target" })).toBeDisabled()

  const search = page.getByRole("searchbox", { name: "Search findings" })
  await search.fill("needle")
  await expect(page.getByRole("button", { name: /Search finding/ })).toBeVisible()
  await search.fill("")
  await expect(page.getByRole("button", { name: /Initial finding/ })).toBeVisible()

  await page.getByRole("combobox", { name: "Filter by severity" }).selectOption("HIGH")
  await expect(page.getByRole("button", { name: /High finding/ })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("button", { name: /Initial finding/ })).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Loaded scoped page/ })).toBeVisible()

  for (const request of requests) {
    const params = new URL(request).searchParams
    expect(params.get("observedInScanId")).toBe("observed-scan")
    expect(params.get("targetId")).toBe("target-test")
  }
  expect(requests.some((request) => new URL(request).searchParams.get("q") === "needle")).toBe(true)
  expect(requests.some((request) => new URL(request).searchParams.get("severity") === "HIGH")).toBe(
    true
  )
  expect(requests.some((request) => new URL(request).searchParams.get("status") === "OPEN")).toBe(
    true
  )
  expect(
    requests.some((request) => new URL(request).searchParams.get("cursor") === "cursor-1")
  ).toBe(true)

  await page.reload()
  await expect(page.getByRole("button", { name: /Restored scoped page/ })).toBeVisible()
  expect(pageLoads).toBe(2)
  const restoredPageRequest = requests.at(-1)!
  expect(new URL(restoredPageRequest).searchParams.get("observedInScanId")).toBe("observed-scan")
  expect(new URL(restoredPageRequest).searchParams.get("targetId")).toBe("target-test")
})

test("scoped finding drawer keeps keyboard and report handoff context at responsive widths", async ({
  page,
}) => {
  const findingsRequests: string[] = []
  const detailRequests: string[] = []
  const reportScopeRequests: string[] = []
  const createBodies: Array<Record<string, unknown>> = []
  let reportRouteUrl: string | null = null

  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/api/findings?**", (route) => {
    findingsRequests.push(route.request().url())
    return route.fulfill(pageOf("initial", "Fixed scoped finding", "FIXED"))
  })
  await page.route("**/api/findings/initial?**", (route) => {
    const url = new URL(route.request().url())
    detailRequests.push(url.toString())
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: "initial",
          title: "Fixed scoped finding",
          summary: "A retained issue with a completed passing retest.",
          scanId: "origin-scan",
          retests: [
            {
              id: "retest-1",
              scanId: "retest-scan",
              status: "passed",
              createdAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          fixProposals: [{ id: "fix-1", status: "merged", summary: "Reviewed fix" }],
        },
      }),
    })
  })
  await page.route("**/api/scans?**", (route) => {
    const url = new URL(route.request().url())
    reportScopeRequests.push(url.toString())
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          items: [
            {
              id: "retest-scan",
              createdAt: "2026-09-01T00:00:00.000Z",
              target: { name: "Test target" },
              status: "COMPLETED",
            },
          ],
          nextCursor: null,
        },
      }),
    })
  })
  await page.route("**/api/reports**", (route) => {
    if (route.request().method() === "POST") {
      createBodies.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { id: "report-1" } }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { items: [], nextCursor: null } }),
    })
  })
  await page.route("**/*", async (route) => {
    const destination = new URL(route.request().url())
    if (destination.pathname !== "/dashboard/reports") return route.fallback()
    reportRouteUrl = destination.toString()
    return route.continue({
      url: new URL(`/e2e/browser/index.html${destination.search}`, destination.origin).toString(),
    })
  })
  for (const width of [390, 768, 1440, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?findings&scanId=origin-scan&target=target-test&withPassingRetest=1")
    await expect(page.getByText("Target: Test target · Scan: origin-scan")).toBeVisible()
    const findingRow = page.getByRole("button", { name: /Fixed scoped finding/ })

    for (let tab = 0; tab < 24; tab++) {
      if (await findingRow.evaluate((element) => element === document.activeElement)) break
      await page.keyboard.press("Tab")
    }
    await expect(findingRow).toBeFocused()
    await page.keyboard.press("Enter")

    const drawer = page.getByRole("dialog", { name: "Fixed scoped finding" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("tab", { name: "What to do" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    const technicalTab = drawer.getByRole("tab", { name: "Technical" })
    await technicalTab.focus()
    await page.keyboard.press("Enter")
    await expect(technicalTab).toHaveAttribute("aria-selected", "true")
    const historyTab = drawer.getByRole("tab", { name: "History" })
    await historyTab.focus()
    await page.keyboard.press("Enter")
    await expect(historyTab).toHaveAttribute("aria-selected", "true")
    const whatToDoTab = drawer.getByRole("tab", { name: "What to do" })
    await whatToDoTab.focus()
    await page.keyboard.press("Enter")
    await expect(whatToDoTab).toHaveAttribute("aria-selected", "true")

    const reportLink = drawer.getByRole("link", { name: "Generate report" })
    await expect(reportLink).toHaveAttribute(
      "href",
      "/dashboard/reports?scanId=retest-scan&targetId=target-test"
    )
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)

    if (width === 390) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%"
      })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width)
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("font-size")
      })
    }

    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(findingRow).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(drawer).toBeVisible()
    await reportLink.focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/dashboard\/reports\?scanId=retest-scan&targetId=target-test$/)
    expect(reportRouteUrl).toContain("scanId=retest-scan")
    expect(reportRouteUrl).toContain("targetId=target-test")
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible()
    const reportScope = page.getByRole("combobox", { name: "Report scope" })
    await expect(reportScope).toHaveValue("scan:retest-scan")
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width)

    const createButton = page.getByRole("button", { name: "Create", exact: true })
    await Promise.all([
      page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === "/api/reports" && request.method() === "POST"
      ),
      createButton.press("Enter"),
    ])
    expect(createBodies.at(-1)).toMatchObject({
      workspaceId: "workspace-test",
      scanId: "retest-scan",
    })
    expect(
      reportScopeRequests.every(
        (request) => new URL(request).searchParams.get("targetId") === "target-test"
      )
    ).toBe(true)
    expect(
      detailRequests.every(
        (request) =>
          new URL(request).searchParams.get("observedInScanId") === "origin-scan" &&
          new URL(request).searchParams.get("targetId") === "target-test"
      )
    ).toBe(true)
    expect(
      findingsRequests.every(
        (request) => new URL(request).searchParams.get("targetId") === "target-test"
      )
    ).toBe(true)
  }

  expect(
    await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  ).toBe(true)
})

test("saving a fix proposal keeps the finding detail scoped to the selected scan and target", async ({
  page,
}) => {
  const detailRequests: string[] = []
  await page.route("**/api/findings/initial?**", (route) => {
    detailRequests.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: "initial",
          title: "Initial finding",
          summary: "Initial summary",
          scanId: "scan-test",
        },
      }),
    })
  })
  await page.route("**/api/findings/initial/fix-proposals", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { id: "fix-1" } }),
    })
  )

  await page.goto("?findings&scanId=scan-test&target=target-test")
  await page.getByRole("button", { name: /Initial finding/ }).click()
  const drawer = page.getByRole("dialog", { name: "Initial finding" })
  await drawer.getByRole("button", { name: "Create fix proposal" }).click()
  await drawer.getByRole("textbox", { name: "Fix summary" }).fill("Apply the scoped fix")
  await drawer.getByRole("button", { name: "Save proposal" }).click()

  await expect.poll(() => detailRequests.length).toBe(2)
  for (const request of detailRequests) {
    const params = new URL(request).searchParams
    expect(params.get("workspaceId")).toBe("workspace-test")
    expect(params.get("targetId")).toBe("target-test")
    expect(params.get("observedInScanId")).toBe("scan-test")
  }
})

test("failed page revalidation keeps fresh first-page results and a usable cursor", async ({
  page,
}) => {
  let pageLoads = 0
  await page.route("**/api/findings?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    if (cursor === "cursor-1") {
      pageLoads++
      return pageLoads === 1
        ? route.fulfill(pageOf("second", "Old second finding"))
        : route.abort("failed")
    }
    return route.fulfill(pageOf("first", "Initial finding"))
  })
  await page.goto("?findings&hasPages=1")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Old second finding/ })).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Could not restore additional results/)).toBeVisible()
  await expect(page.getByRole("button", { name: /Initial finding/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Old second finding/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled()
})

test("restoration owns pagination until its saved page is revalidated", async ({ page }) => {
  let releaseRestore: (() => void) | undefined
  let pageLoads = 0
  await page.route("**/api/findings?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor")
    if (cursor === "cursor-1") {
      pageLoads++
      if (pageLoads === 2)
        await new Promise<void>((resolve) => {
          releaseRestore = resolve
        })
      await route
        .fulfill({
          ...pageOf("second", pageLoads === 1 ? "Old second" : "Fresh second"),
          body: JSON.stringify({
            success: true,
            data: {
              items: [finding("second", pageLoads === 1 ? "Old second" : "Fresh second")],
              nextCursor: "cursor-2",
            },
          }),
        })
        .catch(() => {})
      return
    }
    await route.fulfill(pageOf("third", "Third finding"))
  })
  await page.goto("?findings&hasPages=1")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Old second/ })).toBeVisible()
  await page.reload()
  await expect.poll(() => Boolean(releaseRestore)).toBe(true)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
  releaseRestore?.()
  await expect(page.getByRole("button", { name: /Fresh second/ })).toHaveCount(1)
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(page.getByRole("button", { name: /Third finding/ })).toHaveCount(1)
  expect(pageLoads).toBe(2)
})

test("sorting while a page loads keeps one pagination owner", async ({ page }) => {
  let releasePage: (() => void) | undefined
  let pageLoads = 0
  await page.route("**/api/findings?**", async (route) => {
    pageLoads++
    await new Promise<void>((resolve) => {
      releasePage = resolve
    })
    await route.fulfill(pageOf("second", "Second finding")).catch(() => {})
  })
  await page.goto("?findings&hasPages=1")
  await page.getByRole("button", { name: "Load more" }).click()
  await expect.poll(() => Boolean(releasePage)).toBe(true)
  await page.getByRole("combobox", { name: "Sort loaded results" }).selectOption("severity")
  await expect(page.getByRole("button", { name: "Load more" })).toBeDisabled()
  releasePage?.()
  await expect(page.getByRole("button", { name: /Second finding/ })).toHaveCount(1)
  expect(pageLoads).toBe(1)
})

test("a single saved page restores its scroll position", async ({ page }) => {
  await page.addInitScript(
    (savedFinding) => {
      sessionStorage.setItem(
        "lyrashield:findings-list:workspace-test:OPEN:priority:::",
        JSON.stringify({
          version: 2,
          pages: [{ items: [savedFinding], nextCursor: null }],
          scrollY: 180,
        })
      )
      const originalScrollTo = window.scrollTo.bind(window)
      window.scrollTo = ((x: number, y: number) => {
        ;(window as typeof window & { restoredScrollY?: number }).restoredScrollY = y
        originalScrollTo(x, y)
      }) as typeof window.scrollTo
    },
    finding("initial", "Initial finding")
  )
  await page.goto("?findings")
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { restoredScrollY?: number }).restoredScrollY)
    )
    .toBe(180)
})

test("WebMCP filter and Undo own the query while a saved page is restoring", async ({ page }) => {
  await page.addInitScript(
    (savedFinding) => {
      sessionStorage.setItem(
        "lyrashield:findings-list:workspace-test:OPEN:priority::target-test:needle",
        JSON.stringify({
          version: 2,
          pages: [
            { items: [savedFinding], nextCursor: "cursor-1" },
            { items: [savedFinding], nextCursor: null },
          ],
          scrollY: 0,
        })
      )
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: {
          registerTool(tool: unknown) {
            ;(window as typeof window & { reviewTool?: unknown }).reviewTool = tool
          },
        },
      })
    },
    finding("initial", "Initial finding")
  )
  let releaseRestore: (() => void) | undefined
  const requests: string[] = []
  await page.route("**/api/findings?**", async (route) => {
    const url = new URL(route.request().url())
    requests.push(url.toString())
    if (url.searchParams.get("cursor") === "cursor-1") {
      await new Promise<void>((resolve) => {
        releaseRestore = resolve
      })
      await route.fulfill(pageOf("stale", "Stale Open finding")).catch(() => {})
      return
    }
    await route.fulfill(
      url.searchParams.get("status") === "OPEN"
        ? pageOf("open", "Fresh Open finding")
        : pageOf("all", "All finding")
    )
  })
  await page.goto("?findings&hasPages=1&target=target-test&q=needle")
  await expect.poll(() => Boolean(releaseRestore)).toBe(true)
  await page.evaluate(async () => {
    const tool = (
      window as typeof window & { reviewTool?: { execute(input: unknown): Promise<unknown> } }
    ).reviewTool
    if (!tool) throw new Error("review_findings was not registered")
    await tool.execute({ filter: "ALL" })
  })
  await expect(page.getByRole("button", { name: /All finding/ })).toBeVisible()
  releaseRestore?.()
  await expect(page.getByRole("button", { name: /Stale Open finding/ })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "Filter by status" })).toHaveValue("ALL")
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(page.getByRole("button", { name: /Fresh Open finding/ })).toBeVisible()
  expect(requests.filter((url) => new URL(url).searchParams.has("cursor"))).toHaveLength(1)
  for (const url of requests.filter((url) => !new URL(url).searchParams.has("cursor"))) {
    expect(new URL(url).searchParams.get("targetId")).toBe("target-test")
    expect(new URL(url).searchParams.get("q")).toBe("needle")
  }
})

test("canceling the current WebMCP filter clears stale rows and offers Retry", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: unknown) {
          ;(window as typeof window & { reviewTool?: unknown }).reviewTool = tool
        },
      },
    })
  })
  let releaseAll: (() => void) | undefined
  let allRequests = 0
  await page.route("**/api/findings?**", async (route) => {
    const status = new URL(route.request().url()).searchParams.get("status")
    if (status !== "OPEN") {
      allRequests++
      if (allRequests === 1)
        await new Promise<void>((resolve) => {
          releaseAll = resolve
        })
      await route.fulfill(pageOf("all", "All finding")).catch(() => {})
      return
    }
    await route.fulfill(pageOf("open", "Fresh Open finding"))
  })
  await page.goto("?findings&hasPages=1")
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as typeof window & { reviewTool?: unknown }).reviewTool))
    )
    .toBe(true)
  await page.evaluate(() => {
    const state = window as typeof window & {
      reviewTool?: { execute(input: unknown, options?: { signal: AbortSignal }): Promise<unknown> }
      reviewAbort?: AbortController
      reviewExecution?: Promise<unknown>
    }
    if (!state.reviewTool) throw new Error("review_findings was not registered")
    state.reviewAbort = new AbortController()
    state.reviewExecution = state.reviewTool.execute(
      { filter: "ALL" },
      { signal: state.reviewAbort.signal }
    )
  })
  await expect.poll(() => Boolean(releaseAll)).toBe(true)
  await page.evaluate(() =>
    (window as typeof window & { reviewAbort?: AbortController }).reviewAbort?.abort()
  )
  releaseAll?.()
  await expect(page.getByRole("combobox", { name: "Filter by status" })).toHaveValue("ALL")
  await expect(page.getByRole("button", { name: /Initial finding/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
  await expect(page.getByText(/Failed to load findings/)).toBeVisible()
  await page.getByRole("button", { name: /Retry/i }).click()
  await expect(page.getByRole("button", { name: /All finding/ })).toBeVisible()
})
