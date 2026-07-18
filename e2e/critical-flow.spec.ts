import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const password = "E2e-password-123!"
const ownerEmail = `owner-${suffix}@example.com`
const otherEmail = `other-${suffix}@example.com`
const workspaceName = `E2E ${suffix}`
let createdWorkspaceId: string | null = null

async function signUp(page: import("@playwright/test").Page, email: string, name: string) {
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect.poll(() => prisma.user.findUnique({ where: { email } })).not.toBeNull()
  await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.goto("/sign-in")
  await page.getByLabel("Email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/)
  await page.goto("/onboarding")
  await expect(page).toHaveURL(/\/onboarding/)
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
        await prisma.$transaction([
          prisma.scan.updateMany({
            where: { workspaceId: workspace.id, status: "QUEUED" },
            data: { status: "CANCELLED", endedAt: now, deletedAt: now },
          }),
          prisma.target.updateMany({
            where: { workspaceId: workspace.id },
            data: { deletedAt: now },
          }),
          prisma.workspace.updateMany({
            where: { id: workspace.id, name: workspaceName },
            data: { deletedAt: now },
          }),
          prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } }),
        ])
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

test("anonymous APIs reject access", async ({ request }) => {
  for (const path of [
    "/api/scans?workspaceId=unknown",
    "/api/findings?workspaceId=unknown",
    "/api/reports?workspaceId=unknown",
  ]) {
    expect((await request.get(path)).status()).toBe(401)
  }
})

test("onboarding creates a target and tenant boundaries deny another user", async ({
  page,
  browser,
}) => {
  await signUp(page, ownerEmail, "E2E Owner")

  const workspaceResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/workspaces") && response.request().method() === "POST"
  )
  await page.getByLabel("Workspace name").fill(workspaceName)
  await page.getByRole("button", { name: "Continue" }).click()
  const workspaceBody = await (await workspaceResponse).json()
  const workspaceId = workspaceBody.data.id as string
  createdWorkspaceId = workspaceId

  const targetResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/targets") && response.request().method() === "POST"
  )
  await page.locator("#target-name").fill("Example target")
  await page.locator("#repo-owner").fill("octocat")
  await page.locator("#repo-name").fill("Hello-World")
  await page.getByRole("button", { name: "Continue" }).click()
  const targetBody = await (await targetResponse).json()
  const targetId = targetBody.data.id as string
  await expect(page.getByRole("heading", { name: "Review and start" })).toBeVisible()

  const other = await browser.newContext()
  try {
    const otherPage = await other.newPage()
    await signUp(otherPage, otherEmail, "E2E Other")
    for (const path of ["/api/scans", "/api/findings", "/api/reports"]) {
      expect((await otherPage.request.get(`${path}?workspaceId=${workspaceId}`)).status()).toBe(403)
    }
    const skipOtherOnboarding = await otherPage.request.patch("/api/onboarding", {
      data: { skipped: true },
    })
    await expect(skipOtherOnboarding).toBeOK()
    await otherPage.goto(`/dashboard/targets/${targetId}`)
    await expect(otherPage.getByRole("heading", { name: "404" })).toBeVisible()
  } finally {
    await other.close()
  }
})
