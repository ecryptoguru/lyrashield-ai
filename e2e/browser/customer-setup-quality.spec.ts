import { expect, test } from "@playwright/test"

const setupHealth = {
  version: "lyrashield-setup-health/1.0.0",
  status: "blocked",
  allowed: false,
  checkedAt: "2026-11-05T00:00:00.000Z",
  expiresAt: "2026-11-05T00:01:00.000Z",
  scopeFingerprint: "a".repeat(64),
  scope: {
    workspaceId: "ws-1",
    targetId: "target-1",
    goal: "LAUNCH_REVIEW",
    mode: "STANDARD",
    workflow: "REVIEW_TARGET",
    policyFingerprint: null,
    attachmentFingerprint: null,
    authorizationFingerprint: null,
    sourceRevision: null,
  },
  checks: [
    {
      code: "DOMAIN_VERIFICATION_REQUIRED",
      status: "blocked",
      explanation: "Verify control of this domain once.",
      recoveryAction: "VERIFY_DOMAIN",
    },
  ],
  primaryCheck: "DOMAIN_VERIFICATION_REQUIRED",
  limitations: ["Comparison refs resolve only when a review is submitted."],
}

function freshSetupHealth() {
  const now = Date.now()
  return {
    ...setupHealth,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  }
}

for (const width of [390, 1440]) {
  test(`target assessment remains actionable and readable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route("**/api/v1/setup-health?*", (route) =>
      route.fulfill({ json: { success: true, data: freshSetupHealth() } })
    )
    await page.goto(`?target-assessment=blocked&theme=dark`)

    await expect(page.getByRole("heading", { name: "Assessment" })).toBeVisible()
    await expect(page.getByText("Not assessed")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Agent minutes" })).toBeVisible()
    await expect(page.getByText("Charged: 2 agent minutes.")).toBeVisible()
    await expect(page.getByText("$3.20")).toHaveCount(0)
    await expect(page.getByText("Setup blocked")).toBeVisible()
    await expect(page.getByRole("link", { name: "Start launch review" })).toHaveAttribute(
      "href",
      /new=1/
    )

    const primary = page.getByRole("link", { name: "Start launch review" })
    await primary.focus()
    await expect(primary).toBeFocused()
    const box = await primary.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
    await page.screenshot({ path: testInfo.outputPath(`target-${width}.png`), fullPage: true })

    await page.addStyleTag({ content: "html { font-size: 200%; }" })
    await expect(primary).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )
  })
}

test("expired setup is hidden while a fresh snapshot is fetched", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-05T00:00:00.000Z") })
  let requests = 0
  let releaseRefresh = () => {}
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve
  })
  await page.route("**/api/v1/setup-health?*", async (route) => {
    requests++
    if (requests === 1) {
      await route.fulfill({
        json: {
          success: true,
          data: {
            ...setupHealth,
            status: "ready",
            allowed: true,
            checks: [],
            primaryCheck: "SETUP_READY",
          },
        },
      })
    } else {
      await refreshGate
      await route.fulfill({
        json: {
          success: true,
          data: {
            ...setupHealth,
            checkedAt: "2026-11-05T00:01:00.000Z",
            expiresAt: "2026-11-05T00:02:00.000Z",
          },
        },
      })
    }
  })
  await page.goto("?target-assessment=blocked")
  await expect(page.getByText("Setup ready")).toBeVisible()
  await page.clock.fastForward(60_001)
  await expect.poll(() => requests).toBe(2)
  await expect(page.getByText("Checking current setup…")).toBeVisible()
  await expect(page.getByText("ready", { exact: true })).toHaveCount(0)
  releaseRefresh()
  await expect(page.getByText("Setup blocked")).toBeVisible()
})

test("switching accounts fences an earlier setup response", async ({ page }) => {
  let requests = 0
  let firstFinished = false
  await page.route("**/api/v1/setup-health?*", async (route) => {
    requests++
    if (requests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await route
        .fulfill({
          json: {
            success: true,
            data: {
              ...freshSetupHealth(),
              status: "ready",
              allowed: true,
              checks: [],
              primaryCheck: "SETUP_READY",
            },
          },
        })
        .catch(() => {})
      firstFinished = true
    } else {
      await route.fulfill({ json: { success: true, data: freshSetupHealth() } })
    }
  })
  await page.goto("?target-assessment=blocked")
  await expect.poll(() => requests).toBe(1)
  await page.getByRole("button", { name: "Switch account" }).click()
  await expect.poll(() => requests, { timeout: 2_000 }).toBe(2)
  await expect(page.getByText("Setup blocked")).toBeVisible()
  await expect.poll(() => firstFinished, { timeout: 4_000 }).toBe(true)
  await expect(page.getByText("Setup ready")).toHaveCount(0)
})

test("returning to the page refreshes setup health", async ({ page }) => {
  let requests = 0
  await page.route("**/api/v1/setup-health?*", (route) => {
    requests++
    return route.fulfill({
      json: {
        success: true,
        data:
          requests === 1
            ? {
                ...freshSetupHealth(),
                status: "ready",
                allowed: true,
                checks: [],
                primaryCheck: "SETUP_READY",
              }
            : freshSetupHealth(),
      },
    })
  })
  await page.goto("?target-assessment=blocked")
  await expect(page.getByText("Setup ready")).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(page.getByText("Setup blocked")).toBeVisible()
  expect(requests).toBe(2)
})

test("an already expired response stops and offers retry instead of looping", async ({ page }) => {
  let requests = 0
  await page.route("**/api/v1/setup-health?*", (route) => {
    requests++
    return route.fulfill({ json: { success: true, data: setupHealth } })
  })
  await page.goto("?target-assessment=blocked")
  await expect(page.getByRole("alert")).toContainText("Setup status expired")
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
  expect(requests).toBe(1)
})

test("target panels isolate setup failure from assessment, spend and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let retry = false
  await page.route("**/api/v1/setup-health?*", (route) =>
    route.fulfill(
      retry
        ? { json: { success: true, data: freshSetupHealth() } }
        : {
            status: 503,
            json: { success: false, error: { code: "UNAVAILABLE", message: "Setup unavailable" } },
          }
    )
  )
  await page.goto("?target-assessment=failure&theme=light")
  await expect(page.getByRole("heading", { name: "Assessment" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Agent minutes" })).toBeVisible()
  await expect(page.getByText("Finding counts are unavailable")).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Setup unavailable")
  retry = true
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByText("Setup blocked")).toBeVisible()
})

for (const width of [390, 1440]) {
  test(`private release packet stays usable, keyboard accessible and printable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("?release-packet=historical&theme=dark")
    await expect(page.getByRole("heading", { name: "Release App" })).toBeVisible()
    await expect(page.getByText("Signature unavailable").first()).toBeVisible()
    await expect(page.getByText("Historical — not current evidence")).toBeVisible()
    await expect(page.getByText("Unsupported")).toBeVisible()

    const download = page.getByRole("link", { name: "Download CSV" })
    const print = page.getByRole("button", { name: "Print / Save as PDF" })
    await expect(download).toBeVisible()
    await expect(print).toBeVisible()
    await download.focus()
    await expect(download).toBeFocused()
    expect((await download.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await page.keyboard.press("Tab")
    await expect(print).toBeFocused()
    expect((await print.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(download).toHaveAttribute(
      "href",
      "/api/reports/release-packet/packet-1/download?workspaceId=ws-1"
    )

    const finding = page.getByRole("cell", { name: "Potential tenant escape" })
    await expect(finding).toBeVisible()
    await expect(page.getByRole("link", { name: "Open finding" })).toHaveAttribute(
      "href",
      "/dashboard/findings/finding-1"
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )

    await page.addStyleTag({ content: "html { font-size: 200%; }" })
    await expect(download).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    )

    await page.emulateMedia({ media: "print" })
    await expect(download).toBeHidden()
    await expect(print).toBeHidden()
  })
}
