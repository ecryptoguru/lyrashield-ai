import { expect, test } from "@playwright/test"

function finding(id: string, title: string) {
  return {
    id,
    title,
    summary: title,
    severity: "HIGH",
    status: "OPEN",
    verified: false,
    verificationStatus: "NOT_VERIFIED",
    confidence: "medium",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  }
}

function pageOf(id: string, title: string) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      success: true,
      data: { items: [finding(id, title)], nextCursor: null },
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
  await page.getByRole("button", { name: "All", exact: true }).click()
  await expect.poll(() => Boolean(releaseAll)).toBe(true)
  await page.getByRole("button", { name: "Open", exact: true }).click()
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

test("failed current query can retry without resetting its filter", async ({ page }) => {
  let tries = 0
  await page.route("**/api/findings?**", (route) => {
    tries++
    return tries === 1 ? route.abort("failed") : route.fulfill(pageOf("retry", "Retried finding"))
  })
  await page.goto("?findings")
  await page.getByRole("button", { name: "High", exact: true }).click()
  await expect(page.getByText(/Failed to load findings/)).toBeVisible()
  await page.getByRole("button", { name: /Retry/i }).click()
  await expect(page.getByRole("button", { name: /Retried finding/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "High", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
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
        "lyrashield:findings-list:workspace-test:OPEN:priority::",
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
        "lyrashield:findings-list:workspace-test:OPEN:priority:target-test:needle",
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
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
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
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(page.getByRole("button", { name: /Initial finding/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
  await expect(page.getByText(/Failed to load findings/)).toBeVisible()
  await page.getByRole("button", { name: /Retry/i }).click()
  await expect(page.getByRole("button", { name: /All finding/ })).toBeVisible()
})
