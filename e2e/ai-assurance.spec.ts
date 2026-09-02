import { expect, test } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const simulatedClientOctet =
  (Array.from(suffix).reduce((total, character) => total + character.charCodeAt(0), 0) % 250) + 1
const password = "E2e-password-123!"
const ownerEmail = `e2e-ai-assurance-owner-${suffix}@example.com`
const workspaceName = `E2E AI Assurance ${suffix}`
let createdWorkspaceId: string | null = null

async function signUpAndSignIn(
  page: import("@playwright/test").Page,
  forwardedFor: string,
  email: string
) {
  await page.goto("/sign-up")
  await page.getByLabel("Name").fill("E2E AI Assurance Owner")
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
    const testUser = await prisma.user.findUnique({
      where: { email: ownerEmail },
      select: { id: true },
    })
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
    if (testUser) {
      await prisma.onboardingState.deleteMany({ where: { userId: testUser.id } })
      await prisma.user.delete({ where: { id: testUser.id } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

test("AI assurance dashboard lists the seven evidence-required controls", async ({
  page,
}, testInfo) => {
  const forwardedFor = `192.0.2.${((simulatedClientOctet + testInfo.workerIndex) % 250) + 1}`
  await page.setExtraHTTPHeaders({ "x-forwarded-for": forwardedFor })

  await signUpAndSignIn(page, forwardedFor, ownerEmail)

  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: workspaceName, mode: "VIBE" },
    headers: { Origin: "http://127.0.0.1:3100", "x-forwarded-for": forwardedFor },
  })
  await expect(workspaceResponse).toBeOK()
  const { data: workspace } = await workspaceResponse.json()
  const workspaceId = workspace.id as string
  createdWorkspaceId = workspaceId

  const targetResponse = await page.request.post("/api/targets", {
    data: {
      workspaceId,
      name: "AI Assurance Target",
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

  const evidenceResponse = await page.request.get(
    `/api/ai-assurance/evidence?workspaceId=${workspaceId}&targetId=${targetId}`,
    { headers: { "x-forwarded-for": forwardedFor } }
  )
  await expect(evidenceResponse).toBeOK()
  expect(evidenceResponse.headers()["cache-control"]).toBe("private, no-store")
  const evidence = await evidenceResponse.json()
  expect(evidence.data).toHaveLength(7)

  await page.goto(`/dashboard/ai-assurance?targetId=${targetId}`)
  await expect(
    page.getByRole("heading", { name: "Operational Evidence Vault", level: 1 })
  ).toBeVisible()
  await expect(page.getByLabel("Target")).toBeVisible()

  const controls = page
    .getByRole("list", { name: "AI assurance control evidence" })
    .getByRole("listitem")
  await expect(controls).toHaveCount(7)

  // Sanitized artifact metadata must not leak raw storage URIs.
  await expect(page.getByText("storageUri")).toHaveCount(0)
  await expect(page.getByText("s3://")).toHaveCount(0)

  // Each control card has a readable state badge and manage action.
  await expect(page.getByText("Required").first()).toBeVisible()
  const firstControl = controls.first()
  await firstControl.getByRole("button", { name: /Manage evidence for/ }).click()
  await firstControl.getByLabel("Attestation").fill("Access reviews are recorded quarterly.")
  const submitResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/ai-assurance/evidence") &&
      response.request().method() === "POST"
  )
  await firstControl.getByRole("button", { name: "Submit evidence" }).click()
  const submitResponse = await submitResponsePromise
  expect(submitResponse.ok()).toBe(true)
  const { data: submittedItem } = await submitResponse.json()
  await expect(firstControl.getByText("Submitted")).toBeVisible()

  await page.reload()
  await firstControl.getByRole("button", { name: /Manage evidence for/ }).click()
  await expect(firstControl.getByLabel("Attestation")).toBeVisible()
  const reviewResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/ai-assurance/evidence/${submittedItem.evidenceId}/review`) &&
      response.request().method() === "POST"
  )
  await firstControl.getByRole("button", { name: /Accept version 1/ }).click()
  expect((await reviewResponsePromise).ok()).toBe(true)
  await expect(firstControl.getByText("Accepted")).toBeVisible()
})
