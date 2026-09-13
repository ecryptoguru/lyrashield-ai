import { expect, test } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const simulatedClientOctet =
  (Array.from(suffix).reduce((total, character) => total + character.charCodeAt(0), 0) % 250) + 1
const password = "E2e-password-123!"
const ownerEmail = "e2e-owner@example.com"
const otherEmail = "e2e-other@example.com"
const workspaceName = `E2E ${suffix}`
let createdWorkspaceId: string | null = null

async function signUp(
  page: import("@playwright/test").Page,
  forwardedFor: string,
  email: string,
  name: string
) {
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await expect
    .poll(() =>
      prisma.account.count({
        where: { user: { email }, providerId: "credential", issuer: "local:credential" },
      })
    )
    .toBe(1)
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  // Pass the test's simulated client IP so the auth rate limiter buckets this
  // sign-out under the test's distinct IP, not the shared default — otherwise
  // the 5/min in-memory auth limit is shared across the whole e2e suite and
  // sign-out returns RATE_LIMITED (flaky cross-test interference).
  const signOutResponse = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(signOutResponse).toBeOK()
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  // New users land on onboarding; skip it so the rest of the suite can use the dashboard.
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  const skipOnboarding = await page.request.patch("/api/onboarding", {
    data: { skipped: true },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(skipOnboarding).toBeOK()
  await page.goto("/dashboard")
  await expect(page).toHaveURL("/dashboard")
}

test.afterAll(async () => {
  try {
    const testUsers = await prisma.user.findMany({
      where: { email: { in: [ownerEmail, otherEmail] } },
      select: { id: true },
    })
    const testUserIds = testUsers.map((user) => user.id)
    if (createdWorkspaceId) {
      const workspace = await prisma.workspace.findFirst({
        where: { id: createdWorkspaceId, name: workspaceName },
        select: { id: true },
      })
      if (workspace) {
        const now = new Date()
        await withWorkspaceRLS(workspace.id, async (tx) => {
          await tx.scan.updateMany({
            where: { workspaceId: workspace.id, status: "QUEUED" },
            data: { status: "CANCELLED", endedAt: now, deletedAt: now },
          })
          await tx.target.updateMany({
            where: { workspaceId: workspace.id },
            data: { deletedAt: now },
          })
          await tx.workspace.updateMany({
            where: { id: workspace.id, name: workspaceName },
            data: { deletedAt: now },
          })
          await tx.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } })
        })
      }
    }
    if (testUserIds.length) {
      await prisma.onboardingState.deleteMany({ where: { userId: { in: testUserIds } } })
    }
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, otherEmail] } } })
  } finally {
    await prisma.$disconnect()
  }
})

test("anonymous APIs reject access", async ({ request }, testInfo) => {
  // Give this request its own bucket so parallel E2E workers do not share
  // the "unknown" IP rate-limit window with page-driven tests.
  const forwardedFor = `192.0.2.${((simulatedClientOctet + testInfo.workerIndex) % 250) + 1}`
  for (const path of [
    "/api/scans?workspaceId=unknown",
    "/api/findings?workspaceId=unknown",
    "/api/reports?workspaceId=unknown",
  ]) {
    expect(
      (await request.get(path, { headers: { "x-forwarded-for": forwardedFor } })).status()
    ).toBe(401)
  }
})

test("auth forms recover from a network failure", async ({ page }) => {
  await page.route("**/api/auth/sign-*/email", (route) => route.abort())

  await page.goto("/sign-in")
  await page.getByLabel("Email").fill("user@example.com")
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(
    page.getByText("Could not sign in. Check your connection and try again.")
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled()

  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("Network Error")
  await page.getByLabel("Email").fill("network-error@example.com")
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(
    page.getByText("Could not create your account. Check your connection and try again.")
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled()
})

test("tenant boundaries deny another user", async ({ page, browser }, testInfo) => {
  // The production proxy accepts this header only from configured trusted
  // ingress. Give repeated E2E workers distinct simulated clients so the
  // production auth limiter is exercised without unrelated fixtures sharing
  // a single IP bucket.
  const forwardedFor = `198.51.100.${((simulatedClientOctet + testInfo.workerIndex) % 250) + 1}`
  await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })
  await signUp(page, forwardedFor, ownerEmail, "E2E Owner")

  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: workspaceName, mode: "VIBE" },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(workspaceResponse).toBeOK()
  const { data: workspace } = await workspaceResponse.json()
  const workspaceId = workspace.id as string
  createdWorkspaceId = workspaceId

  await page.goto("/dashboard")
  await expect(page.getByRole("heading", { name: "Add your first target" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Add a target" }).first()).toHaveAttribute(
    "href",
    "/dashboard/targets"
  )

  const targetResponse = await page.request.post("/api/targets", {
    data: {
      workspaceId,
      name: "Example target",
      type: "WEB_APP",
      url: "https://example.com",
      environment: "STAGING",
      ownershipAttested: true,
    },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(targetResponse).toBeOK()
  const { data: target } = await targetResponse.json()
  const targetId = target.id as string

  const apiTargetResponse = await page.request.post("/api/targets", {
    data: {
      workspaceId,
      name: "API without contract",
      type: "API",
      url: "https://example.com/api",
      environment: "STAGING",
      ownershipAttested: true,
    },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(apiTargetResponse).toBeOK()
  const { data: apiTarget } = await apiTargetResponse.json()
  const apiTargetId = apiTarget.id as string

  const contractTargetResponse = await page.request.post("/api/targets", {
    data: {
      workspaceId,
      name: "API with contract",
      type: "API",
      url: "https://example.com/api/contract",
      apiSpecUrl: "https://example.com/openapi.json",
      environment: "STAGING",
      ownershipAttested: true,
    },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(contractTargetResponse).toBeOK()

  await page.goto("/dashboard")
  await expect(page.getByRole("heading", { name: "Run your first review" })).toBeVisible()
  // W2-07: the scan recommendation preselects the recommended target in the
  // composer href.
  await expect(page.getByRole("link", { name: "Start a scan" }).first()).toHaveAttribute(
    "href",
    /\/dashboard\/scans\?new=1(&target=[A-Za-z0-9]+)?$/
  )

  const restoreOnboardingResponse = await page.request.patch("/api/onboarding", {
    data: {
      currentStep: 3,
      skipped: false,
      workspaceId,
      targetId: apiTargetId,
      selectedGoal: "LAUNCH_REVIEW",
    },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(restoreOnboardingResponse).toBeOK()

  let scanAttempts = 0
  await page.route("**/api/scans", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    scanAttempts += 1
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { code: "SCAN_SERVICE_UNAVAILABLE", message: "Retry the restored review." },
      }),
    })
  })
  await page.goto("/onboarding")
  // W2-04: the recommended review renders as a highlighted card, with the
  // other supported reviews behind "Change review".
  await expect(page.getByText("Recommended review for this API")).toBeVisible()
  await expect(page.getByText("Endpoint Review", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("target details are locked for this retry")).toBeVisible()
  await expect(page.locator("#product-name")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0)
  const restoredReviewButton = page.getByRole("button", { name: "Start endpoint review" })
  await restoredReviewButton.click()
  await expect(restoredReviewButton).toBeEnabled()
  await restoredReviewButton.click()
  await expect(restoredReviewButton).toBeEnabled()
  expect(scanAttempts).toBe(2)
  expect(await prisma.target.count({ where: { workspaceId } })).toBe(3)
  await page.unroute("**/api/scans")

  const finishOnboardingResponse = await page.request.patch("/api/onboarding", {
    data: { skipped: true },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(finishOnboardingResponse).toBeOK()

  await page.goto("/dashboard/scans?new=1")
  const targetSelect = page.getByLabel("Target", { exact: true })
  await targetSelect.selectOption({ label: "Example target (Web app)" })
  await expect(page.getByRole("radio", { name: /^Surface Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Engine Review:/ })).toBeEnabled()
  const webDeep = page.getByRole("radio", { name: /^Deep Live Review:/ })
  await expect(webDeep).toBeEnabled()
  await webDeep.click()

  await targetSelect.selectOption({ label: "API without contract (API)" })
  await expect(page.getByRole("radio", { name: /^Endpoint Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Engine Contract Review:/ })).toBeDisabled()
  await expect(page.getByRole("radio", { name: /^Deep Contract Review:/ })).toBeDisabled()
  await expect(page.getByRole("link", { name: "Add OpenAPI document" })).toHaveAttribute(
    "href",
    `/dashboard/targets/${apiTargetId}`
  )
  await expect(page.getByRole("status").filter({ hasText: "Review type reset" })).toContainText(
    "Endpoint Review"
  )

  await targetSelect.selectOption({ label: "API with contract (API)" })
  await expect(page.getByRole("radio", { name: /^Engine Contract Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Deep Contract Review:/ })).toBeEnabled()

  const owner = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
  const fixture = await withWorkspaceRLS(workspaceId, async (tx) => {
    const created = await tx.scan.create({
      data: {
        workspaceId,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        status: "QUEUED",
        createdById: owner.id,
      },
    })
    await tx.scanEvent.create({
      data: { scanId: created.id, stage: "queued", level: "info", message: "Scan queued" },
    })
    const finding = await tx.finding.create({
      data: {
        workspaceId,
        targetId,
        scanId: created.id,
        title: "Unexpected request field accepted",
        summary: "The request accepts an undocumented field.",
        severity: "HIGH",
        confidence: "high",
        status: "OPEN",
        verificationStatus: "DETECTED",
        dedupeKey: `e2e-dashboard-${suffix}`,
      },
    })
    return { scan: created, finding }
  })
  const importedReport = {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "E2E external scanner" } },
        results: [
          {
            ruleId: "external-check",
            level: "warning",
            message: { text: "External detection", id: "external-message" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/example.ts", uriBaseId: "SRCROOT" },
                  region: { startLine: 10, snippet: { text: "example()" } },
                },
              },
            ],
          },
        ],
      },
    ],
  }
  const importUrl = `/api/scans/${fixture.scan.id}/artifacts/sarif?workspaceId=${workspaceId}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const imported = await page.request.post(importUrl, {
      data: importedReport,
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    })
    await expect(imported).toBeOK()
    expect((await imported.json()).data).toMatchObject({
      imported: attempt === 0 ? 1 : 0,
      corroborated: attempt === 0 ? 0 : 1,
    })
  }
  await withWorkspaceRLS(workspaceId, async (tx) => {
    expect(
      await tx.findingCandidate.count({
        where: { workspaceId, scanId: fixture.scan.id, scannerSource: "external_import" },
      })
    ).toBe(1)
    expect(
      await tx.scanCoverageReceipt.count({
        where: { scanId: fixture.scan.id, scan: { workspaceId } },
      })
    ).toBe(0)
  })
  const redetectionFixture = await withWorkspaceRLS(workspaceId, async (tx) => {
    const candidate = await tx.findingCandidate.findFirstOrThrow({
      where: { workspaceId, scanId: fixture.scan.id, scannerSource: "external_import" },
    })
    expect(candidate.payload).toMatchObject({
      sarifResult: importedReport.runs[0]!.results[0],
    })
    await tx.finding.update({
      where: { id: candidate.findingId! },
      data: { status: "FIXED_PENDING_RETEST" },
    })
    const newer = await tx.scan.create({
      data: {
        workspaceId,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        status: "QUEUED",
        createdById: owner.id,
        createdAt: new Date(fixture.scan.createdAt.getTime() + 1000),
      },
    })
    return { candidate, newer }
  })
  const strongerReport = structuredClone(importedReport)
  strongerReport.runs[0]!.results[0]!.level = "error"
  const redetected = await page.request.post(
    `/api/scans/${redetectionFixture.newer.id}/artifacts/sarif?workspaceId=${workspaceId}`,
    {
      data: strongerReport,
      headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
    }
  )
  await expect(redetected).toBeOK()
  const oldReplay = await page.request.post(importUrl, {
    data: importedReport,
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(oldReplay).toBeOK()
  const conflictingReport = structuredClone(strongerReport)
  conflictingReport.runs[0]!.results.unshift({
    ...conflictingReport.runs[0]!.results[0]!,
    ruleId: "must-not-persist-conflict",
  })
  const conflict = await page.request.post(importUrl, {
    data: conflictingReport,
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  expect(conflict.status()).toBe(409)
  await withWorkspaceRLS(workspaceId, async (tx) => {
    expect(
      await tx.finding.count({
        where: { workspaceId, targetId, sarifRuleId: "must-not-persist-conflict" },
      })
    ).toBe(0)
    const finding = await tx.finding.findFirstOrThrow({
      where: { workspaceId, id: redetectionFixture.candidate.findingId! },
    })
    expect(finding).toMatchObject({
      scanId: redetectionFixture.newer.id,
      severity: "HIGH",
      status: "OPEN",
      verified: false,
      verificationStatus: "DETECTED",
    })
    const original = await tx.findingCandidate.findFirstOrThrow({
      where: { workspaceId, id: redetectionFixture.candidate.id },
    })
    expect(original.payload).toEqual(redetectionFixture.candidate.payload)
    expect(original.evidenceHash).toBe(redetectionFixture.candidate.evidenceHash)
    expect(
      await tx.findingCandidate.count({
        where: { workspaceId, findingId: finding.id, scannerSource: "external_import" },
      })
    ).toBe(2)
  })
  const rejectedImport = await page.request.post(importUrl, {
    data: importedReport,
    headers: { Origin: "https://untrusted.example", "x-forwarded-for": forwardedFor },
  })
  expect(rejectedImport.status()).toBe(403)

  await page.goto(`/dashboard/scans/${fixture.scan.id}`)
  await expect(page.getByRole("heading", { name: "Scan queued", level: 1 })).toBeVisible()

  const dashboardConsoleErrors: string[] = []
  const dashboardPageErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") dashboardConsoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => dashboardPageErrors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of [
    "/dashboard",
    "/dashboard/targets",
    "/dashboard/scans",
    `/dashboard/scans/${fixture.scan.id}`,
    "/dashboard/findings",
    `/dashboard/findings?finding=${fixture.finding.id}`,
  ]) {
    await page.goto(path)
    await expect(page.locator("#main-content")).toBeVisible()
    await expect(page.locator("h1").first()).toBeVisible()
    await expect(page.locator("body")).not.toContainText("$RS")
    const pageScrollX = await page.evaluate(() => {
      window.scrollTo({ left: 10_000 })
      const position = window.scrollX
      window.scrollTo({ left: 0 })
      return position
    })
    expect(pageScrollX, `Horizontal page scroll at ${path}`).toBe(0)
  }
  await expect(page.getByText("Unexpected request field accepted").first()).toBeVisible()
  const bottomNavSpacing = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("#main-content")!
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')!
    return {
      bottomPadding: Number.parseFloat(getComputedStyle(main).paddingBottom),
      navHeight: nav.getBoundingClientRect().height,
    }
  })
  expect(bottomNavSpacing.bottomPadding).toBeGreaterThanOrEqual(bottomNavSpacing.navHeight)
  expect(dashboardPageErrors).toEqual([])
  expect(dashboardConsoleErrors).toEqual([])

  // Keep authorization proof independent of the owner's API rate-limit bucket.
  const otherForwardedFor = `192.0.2.${((simulatedClientOctet + testInfo.workerIndex) % 250) + 1}`
  const other = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": otherForwardedFor },
  })
  try {
    const otherPage = await other.newPage()
    await signUp(otherPage, otherForwardedFor, otherEmail, "E2E Other")
    for (const path of ["/api/scans", "/api/findings", "/api/reports"]) {
      expect(
        (
          await otherPage.request.get(`${path}?workspaceId=${workspaceId}`, {
            headers: { "x-forwarded-for": otherForwardedFor },
          })
        ).status()
      ).toBe(403)
    }
    await otherPage.goto(`/dashboard/targets/${targetId}`)
    await expect(otherPage.getByRole("heading", { name: /404|Not in evidence/i })).toBeVisible()
    await otherPage.goto(`/dashboard/scans/${fixture.scan.id}`)
    await expect(otherPage.getByRole("heading", { name: "No workspace yet" })).toBeVisible()
  } finally {
    await other.close()
  }
})
