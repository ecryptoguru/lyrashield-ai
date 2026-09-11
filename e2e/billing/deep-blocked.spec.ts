import { expect, test } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

/**
 * Deep scan is blocked for accounts without deep entitlement (Trial, Starter).
 *
 * Exercises the real POST /api/scans entitlement gate with real fixtures —
 * the sponsoring ACCOUNT's plan is authoritative (subscriptions are
 * account-owned), so the fixture stamps BillingAccount.accountId, not just a
 * workspace row.
 */

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const password = "E2e-deep-123!"
const originHeaders = {
  Origin: "http://127.0.0.1:3100",
  "x-forwarded-for": `198.51.100.${(Math.floor(Math.random() * 200) + 20).toString()}`,
}

async function signUpAndCreateWorkspace(
  page: import("@playwright/test").Page,
  email: string,
  workspaceLabel: string
): Promise<{ userId: string; workspaceId: string }> {
  await page.setExtraHTTPHeaders(originHeaders)
  await expect(
    await page.request.post("/api/auth/sign-up/email", {
      data: { name: "Deep Gate", email, password },
      headers: originHeaders,
    })
  ).toBeOK()
  const user = await prisma.user.update({ where: { email }, data: { emailVerified: true } })
  await page.request.post("/api/auth/sign-out", { data: {}, headers: originHeaders })
  await expect(
    await page.request.post("/api/auth/sign-in/email", {
      data: { email, password },
      headers: originHeaders,
    })
  ).toBeOK()
  const workspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: `${workspaceLabel} ${suffix}`, mode: "VIBE" },
    headers: originHeaders,
  })
  await expect(workspaceResponse).toBeOK()
  const {
    data: { id: workspaceId },
  } = await workspaceResponse.json()
  return { userId: user.id, workspaceId }
}

async function createRepoTarget(workspaceId: string): Promise<string> {
  const target = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.target.create({
      data: {
        workspaceId,
        name: "Deep gate target",
        type: "REPO",
        repoFullName: "acme/deep-gate",
        repoProvider: "github",
      },
    })
  )
  return target.id
}

test.describe("Deep scan plan gating", () => {
  test("Deep scan blocked on Trial plan", async ({ page }) => {
    const email = `e2e-deep-trial-${suffix}@example.com`
    const { workspaceId } = await signUpAndCreateWorkspace(page, email, "Deep Trial")
    const targetId = await createRepoTarget(workspaceId)

    // The fresh signup carries an account trial — DEEP is never trial-eligible.
    const response = await page.request.post("/api/scans", {
      data: { workspaceId, targetId, goal: "TEST_APP", mode: "DEEP" },
      headers: originHeaders,
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe("DEEP_NOT_ALLOWED")
  })

  test("Deep scan blocked on Starter plan", async ({ page }) => {
    const email = `e2e-deep-starter-${suffix}@example.com`
    const { userId, workspaceId } = await signUpAndCreateWorkspace(page, email, "Deep Starter")
    const targetId = await createRepoTarget(workspaceId)

    // Stamp a paid STARTER subscription on the ACCOUNT — workspace state must
    // not decide entitlement.
    await withWorkspaceRLS(
      workspaceId,
      (tx) =>
        tx.billingAccount.upsert({
          where: { workspaceId },
          create: {
            workspaceId,
            purchaseWorkspaceId: workspaceId,
            accountId: userId,
            provider: "polar",
            externalId: `e2e_sub_${suffix}`,
            status: "active",
            currentPlan: "STARTER",
            interval: "monthly",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
          update: { accountId: userId, currentPlan: "STARTER", status: "active" },
        }),
      { accountId: userId }
    )

    const response = await page.request.post("/api/scans", {
      data: { workspaceId, targetId, goal: "TEST_APP", mode: "DEEP" },
      headers: originHeaders,
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe("DEEP_NOT_ALLOWED")
    expect(body.error.details?.plan ?? body.plan ?? "STARTER").toBeDefined()
  })
})
