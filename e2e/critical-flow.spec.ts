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
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  const signOutResponse = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { Origin: "http://127.0.0.1:3100" },
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
    headers: { "x-forwarded-for": forwardedFor },
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
    headers: { "x-forwarded-for": forwardedFor },
  })
  await expect(workspaceResponse).toBeOK()
  const { data: workspace } = await workspaceResponse.json()
  const workspaceId = workspace.id as string
  createdWorkspaceId = workspaceId

  const targetResponse = await page.request.post("/api/targets", {
    data: {
      workspaceId,
      name: "Example target",
      type: "WEB_APP",
      url: "https://example.com",
      environment: "STAGING",
      ownershipAttested: true,
    },
    headers: { "x-forwarded-for": forwardedFor },
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
    headers: { "x-forwarded-for": forwardedFor },
  })
  await expect(apiTargetResponse).toBeOK()

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
    headers: { "x-forwarded-for": forwardedFor },
  })
  await expect(contractTargetResponse).toBeOK()

  await page.goto("/dashboard/scans?new=1")
  const targetSelect = page.getByLabel("Target")
  await targetSelect.selectOption({ label: "Example target (WEB_APP)" })
  await expect(page.getByRole("radio", { name: /^Surface Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Expanded Surface Review:/ })).toBeEnabled()
  const webDeep = page.getByRole("radio", { name: /^Behavioral Surface Review:/ })
  await expect(webDeep).toBeEnabled()
  await webDeep.click()

  await targetSelect.selectOption({ label: "API without contract (API)" })
  await expect(page.getByRole("radio", { name: /^Endpoint Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Contract Review:/ })).toBeDisabled()
  await expect(page.getByRole("radio", { name: /^Contract Behavior Review:/ })).toBeDisabled()
  await expect(page.getByRole("status").filter({ hasText: "Review type reset" })).toContainText(
    "Endpoint Review"
  )

  await targetSelect.selectOption({ label: "API with contract (API)" })
  await expect(page.getByRole("radio", { name: /^Contract Review:/ })).toBeEnabled()
  await expect(page.getByRole("radio", { name: /^Contract Behavior Review:/ })).toBeEnabled()

  const owner = await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
  const scan = await withWorkspaceRLS(workspaceId, async (tx) => {
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
    return created
  })
  await page.goto(`/dashboard/scans/${scan.id}`)
  await expect(page.getByRole("heading", { name: "Scan queued", level: 1 })).toBeVisible()

  const other = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": forwardedFor },
  })
  try {
    const otherPage = await other.newPage()
    await signUp(otherPage, forwardedFor, otherEmail, "E2E Other")
    for (const path of ["/api/scans", "/api/findings", "/api/reports"]) {
      expect(
        (
          await otherPage.request.get(`${path}?workspaceId=${workspaceId}`, {
            headers: { "x-forwarded-for": forwardedFor },
          })
        ).status()
      ).toBe(403)
    }
    await otherPage.goto(`/dashboard/targets/${targetId}`)
    await expect(otherPage.getByRole("heading", { name: /404|Not in evidence/i })).toBeVisible()
    await otherPage.goto(`/dashboard/scans/${scan.id}`)
    await expect(otherPage.getByRole("heading", { name: "No workspace yet" })).toBeVisible()
  } finally {
    await other.close()
  }
})
