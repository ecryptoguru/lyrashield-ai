import { expect, test, type Page } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

const password = "E2e-password-123!"

async function signUpAndEnterDashboard(page: Page, email: string, forwardedFor: string) {
  await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("Visual QA Owner")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.waitForURL(/\/(dashboard|onboarding)/)
  await page.waitForLoadState("networkidle")

  const signOut = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(signOut).toBeOK()

  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  const skipOnboarding = await page.request.patch("/api/onboarding", {
    data: { skipped: true },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(skipOnboarding).toBeOK()
}

async function expectDashboardReady(page: Page) {
  await expect(page.locator("#main-content")).toBeVisible()
  await expect(page.locator("h1").first()).toBeVisible()
  await expect(page.locator("body")).not.toContainText("$RS")
  const horizontalOverflow = await page.evaluate(() => {
    window.scrollTo({ left: 10_000 })
    const position = window.scrollX
    window.scrollTo({ left: 0 })
    return {
      position,
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map((element) => {
          const parent = element.parentElement
          return `${element.tagName.toLowerCase()}.${element.className} right=${element.getBoundingClientRect().right} parent=${parent?.tagName.toLowerCase()}.${parent?.className} parentWidth=${parent?.getBoundingClientRect().width} parentOverflow=${parent ? getComputedStyle(parent).overflowX : ""}`
        }),
    }
  })
  expect(
    horizontalOverflow,
    `horizontal overflow on ${page.url()}: ${JSON.stringify(horizontalOverflow)}`
  ).toMatchObject({ position: 0 })
  await page.waitForLoadState("networkidle")
}

async function capture(page: Page, name: string) {
  await expectDashboardReady(page)
  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  })
}

test("authenticated post-login dashboard flow @visual", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const projectSlug = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  const email = `visual-${projectSlug}-${runSuffix}@example.com`
  const workspaceName = `Visual QA ${testInfo.project.name}`
  const forwardedFor = `198.51.100.${(testInfo.workerIndex % 250) + 1}`
  let workspaceId: string | null = null

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.message}`))
  await page.addInitScript(() => {
    const metrics = { lcp: 0, cls: 0 }
    ;(window as typeof window & { __dashboardMetrics: typeof metrics }).__dashboardMetrics = metrics
    new PerformanceObserver((list) => {
      const entries = list.getEntries()
      metrics.lcp = entries.at(-1)?.startTime ?? metrics.lcp
    }).observe({ type: "largest-contentful-paint", buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
        if (!shift.hadRecentInput) metrics.cls += shift.value
      }
    }).observe({ type: "layout-shift", buffered: true })
  })

  try {
    await signUpAndEnterDashboard(page, email, forwardedFor)

    const workspaceResponse = await page.request.post("/api/workspaces", {
      data: { name: `${workspaceName} ${runSuffix}`, mode: "VIBE" },
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
    await expect(workspaceResponse).toBeOK()
    workspaceId = (await workspaceResponse.json()).data.id as string

    const targetResponse = await page.request.post("/api/targets", {
      data: {
        workspaceId,
        name: "Checkout API",
        type: "API",
        url: "https://example.com/api",
        apiSpecUrl: "https://example.com/openapi.json",
        environment: "STAGING",
        ownershipAttested: true,
      },
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
    await expect(targetResponse).toBeOK()
    const targetId = (await targetResponse.json()).data.id as string
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } })

    const fixture = await withWorkspaceRLS(workspaceId, async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId! }, data: { name: workspaceName } })
      const scan = await tx.scan.create({
        data: {
          workspaceId: workspaceId!,
          targetId,
          goal: "LAUNCH_REVIEW",
          mode: "SAFE",
          status: "PARTIAL",
          startedAt: new Date("2026-08-31T10:00:00Z"),
          endedAt: new Date("2026-08-31T10:03:12Z"),
          createdAt: new Date("2026-08-31T10:00:00Z"),
          durationMs: 192_000,
          summary: "The review completed with one retained issue and complete API coverage.",
          createdById: owner.id,
        },
      })
      await tx.scanCoverageReceipt.create({
        data: {
          scanId: scan.id,
          scanner: "api-contract",
          controlId: "api-contract-coverage",
          status: "COMPLETED",
          subject: "Checkout API",
        },
      })
      const finding = await tx.finding.create({
        data: {
          workspaceId: workspaceId!,
          targetId,
          scanId: scan.id,
          title: "Request body accepts unexpected fields",
          summary:
            "The API contract allows fields that are not required by the documented request.",
          category: "Input validation",
          cwe: "CWE-20",
          severity: "HIGH",
          confidence: "high",
          status: "OPEN",
          verificationStatus: "DETECTED",
          dedupeKey: `visual-input-validation-${runSuffix}`,
          firstSeenAt: new Date("2026-08-31T10:02:00Z"),
          lastSeenAt: new Date("2026-08-31T10:02:00Z"),
          createdAt: new Date("2026-08-31T10:02:00Z"),
        },
      })
      await tx.scoreSnapshot.create({
        data: {
          workspaceId: workspaceId!,
          targetId,
          scanId: scan.id,
          modelVersion: "visual-fixture-v1",
          score: 78,
          grade: "C",
          breakdown: { high: 1 },
          scanMode: "SAFE",
          computedAt: new Date("2026-08-31T10:03:12Z"),
          expiresAt: new Date("2026-09-30T10:03:12Z"),
        },
      })
      return { scanId: scan.id, findingId: finding.id }
    })

    consoleErrors.length = 0
    pageErrors.length = 0
    await page.goto("/dashboard")
    await capture(page, "dashboard-home-light.png")
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __dashboardMetrics: { lcp: number; cls: number } })
              .__dashboardMetrics.lcp
        )
      )
      .toBeGreaterThan(0)
    const dashboardMetrics = await page.evaluate(
      () =>
        (window as typeof window & { __dashboardMetrics: { lcp: number; cls: number } })
          .__dashboardMetrics
    )
    expect(dashboardMetrics.lcp).toBeLessThan(2_500)
    expect(dashboardMetrics.cls).toBeLessThan(0.1)

    await page.evaluate(() => {
      localStorage.setItem("lyrashield-theme", "dark")
      document.documentElement.classList.add("dark")
      document.documentElement.dataset.theme = "dark"
      document.documentElement.style.colorScheme = "dark"
    })
    await capture(page, "dashboard-home-dark.png")

    await page.evaluate(() => {
      localStorage.setItem("lyrashield-theme", "light")
      document.documentElement.classList.remove("dark")
      document.documentElement.dataset.theme = "light"
      document.documentElement.style.colorScheme = "light"
    })

    for (const [path, screenshot] of [
      ["/dashboard/targets", "targets-list.png"],
      ["/dashboard/scans", "runs-list.png"],
      [`/dashboard/scans/${fixture.scanId}`, "run-detail.png"],
      ["/dashboard/findings", "issues-queue.png"],
      [`/dashboard/findings?finding=${fixture.findingId}`, "issue-detail.png"],
    ] as const) {
      await page.goto(path)
      await capture(page, screenshot)
    }

    if (testInfo.project.name === "visual-mobile") {
      const bottomNav = page.getByRole("navigation", { name: "Main navigation" })
      await expect(bottomNav).toBeVisible()
      const layoutSpacing = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("#main-content")!
        const nav = document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')!
        return {
          bottomPadding: Number.parseFloat(getComputedStyle(main).paddingBottom),
          navHeight: nav.getBoundingClientRect().height,
        }
      })
      expect(layoutSpacing.bottomPadding).toBeGreaterThanOrEqual(layoutSpacing.navHeight)
    }

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (workspaceId) {
      const now = new Date()
      await withWorkspaceRLS(workspaceId, async (tx) => {
        await tx.finding.updateMany({ where: { workspaceId }, data: { deletedAt: now } })
        await tx.scan.updateMany({ where: { workspaceId }, data: { deletedAt: now } })
        await tx.target.updateMany({ where: { workspaceId }, data: { deletedAt: now } })
        await tx.workspace.updateMany({ where: { id: workspaceId }, data: { deletedAt: now } })
        await tx.workspaceMember.deleteMany({ where: { workspaceId } })
      })
    }
    if (user) {
      await prisma.onboardingState.deleteMany({ where: { userId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  }
})
