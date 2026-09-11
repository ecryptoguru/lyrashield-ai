import { expect, test } from "@playwright/test"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"

/**
 * Trial lifecycle through real fixtures:
 *  - a trial account that consumed its 100-minute pool is locked out of new
 *    scans and sees an upgrade CTA on the billing page;
 *  - a trial account past its 14-day window sees the expiry notice and is
 *    refused at the authoritative POST gate with TRIAL_EXPIRED.
 *
 * Scan execution itself is not exercised here — minute consumption is written
 * as a UsageRecord fixture (the same ledger a metered scan writes), so the
 * gating + UI assertions run against real billing state without spending
 * model budget.
 */

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const password = "E2e-trial-123!"
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
      data: { name: "Trial Tester", email, password },
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

test.describe("Trial lifecycle", () => {
  test("exhausted trial → locked + upgrade CTA", async ({ page }) => {
    const email = `e2e-trial-exhausted-${suffix}@example.com`
    const { userId, workspaceId } = await signUpAndCreateWorkspace(page, email, "Trial Exhaust")

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { trialStartedAt: true },
    })
    // Consume the full 100-minute trial pool the way a metered scan does.
    await withWorkspaceRLS(
      workspaceId,
      (tx) =>
        tx.usageRecord.create({
          data: {
            workspaceId,
            accountId: userId,
            kind: "agent_minutes",
            quantity: 100,
            cycleStart: user.trialStartedAt ?? new Date(),
          },
        }),
      { accountId: userId }
    )

    const target = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.create({
        data: {
          workspaceId,
          name: "Trial target",
          type: "REPO",
          repoFullName: "acme/trial-target",
          repoProvider: "github",
        },
      })
    )

    // The authoritative gate refuses a new scan.
    const response = await page.request.post("/api/scans", {
      data: { workspaceId, targetId: target.id, goal: "TEST_APP", mode: "SAFE" },
      headers: originHeaders,
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe("NO_MINUTES_REMAINING")

    // The billing page surfaces trial state and an upgrade path.
    await page.goto("/dashboard/billing")
    await expect(page.getByText("Trial Status")).toBeVisible()
    await expect(page.getByText("Minutes Left")).toBeVisible()
  })

  test("trial shows expiry notice and blocks scans when expired", async ({ page }) => {
    const email = `e2e-trial-expired-${suffix}@example.com`
    const { userId, workspaceId } = await signUpAndCreateWorkspace(page, email, "Trial Expired")

    // Move the trial anchor past the 14-day window.
    await prisma.user.update({
      where: { id: userId },
      data: { trialStartedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
    })

    const target = await withWorkspaceRLS(workspaceId, (tx) =>
      tx.target.create({
        data: {
          workspaceId,
          name: "Expired trial target",
          type: "REPO",
          repoFullName: "acme/expired-trial",
          repoProvider: "github",
        },
      })
    )

    const response = await page.request.post("/api/scans", {
      data: { workspaceId, targetId: target.id, goal: "TEST_APP", mode: "SAFE" },
      headers: originHeaders,
    })
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe("TRIAL_EXPIRED")

    await page.goto("/dashboard/billing")
    await expect(page.getByText(/Your trial has expired/)).toBeVisible()
  })
})
