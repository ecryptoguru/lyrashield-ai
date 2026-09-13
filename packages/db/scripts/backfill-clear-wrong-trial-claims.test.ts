import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "../src/client"
import { computeAuditHash } from "../src/audit-hash"
import { runTrialClaimBackfill, type DbTx } from "./backfill-clear-wrong-trial-claims"

/**
 * Live-Postgres coverage for the wrong-trial-claim backfill: a correctly
 * claimed user is untouched, a wrongly stamped user is cleared, and a dry run
 * writes nothing.
 */

const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
const ids = {
  claimed: `trial-claimed-${suffix}`,
  stamped: `trial-stamped-${suffix}`,
  grantOnly: `trial-grantonly-${suffix}`,
  orphan: `trial-orphan-${suffix}`,
  workspace: `trial-ws-${suffix}`,
}

async function seed() {
  await prisma.workspace.create({ data: { id: ids.workspace, name: "Trial", slug: ids.workspace } })
  const now = new Date()
  await prisma.user.createMany({
    data: [
      {
        id: ids.claimed,
        name: "Claimed",
        email: `${ids.claimed}@example.invalid`,
        trialStartedAt: now,
      },
      {
        id: ids.stamped,
        name: "Stamped",
        email: `${ids.stamped}@example.invalid`,
        trialStartedAt: now,
      },
      {
        id: ids.grantOnly,
        name: "GrantOnly",
        email: `${ids.grantOnly}@example.invalid`,
        trialStartedAt: now,
      },
      {
        id: ids.orphan,
        name: "Orphan",
        email: `${ids.orphan}@example.invalid`,
        trialStartedAt: now,
      },
    ],
  })
  // A real claim: marker row + grant row for the account.
  await prisma.billingAccount.create({
    data: {
      accountId: ids.claimed,
      workspaceId: null,
      purchaseWorkspaceId: ids.workspace,
      provider: "trial",
      status: "trialing",
      currentPlan: "FREE",
    },
  })
  await prisma.usageRecord.create({
    data: {
      workspaceId: ids.workspace,
      accountId: ids.claimed,
      kind: "trial_grant",
      quantity: 60,
      idempotencyKey: `${ids.claimed}:TRIAL`,
    },
  })
  // Grant without a marker is ambiguous — conservatively not a candidate.
  await prisma.usageRecord.create({
    data: {
      workspaceId: ids.workspace,
      accountId: ids.grantOnly,
      kind: "trial_grant",
      quantity: 60,
      idempotencyKey: `${ids.grantOnly}:TRIAL`,
    },
  })
  // The wrongly stamped user owns this workspace (audit lands on its chain).
  await prisma.workspaceMember.create({
    data: { workspaceId: ids.workspace, userId: ids.stamped, role: "OWNER" },
  })
  // The orphan owns no workspace — cleared but reported unaudited.
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { workspaceId: ids.workspace } })
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: ids.workspace } })
  await prisma.usageRecord.deleteMany({ where: { workspaceId: ids.workspace } })
  await prisma.billingAccount.deleteMany({ where: { purchaseWorkspaceId: ids.workspace } })
  await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
  await prisma.user.deleteMany({
    where: { id: { in: [ids.claimed, ids.stamped, ids.grantOnly, ids.orphan] } },
  })
}

describe("backfill-clear-wrong-trial-claims (live Postgres)", () => {
  afterAll(cleanup)

  it("dry run lists only wrongly stamped users and writes nothing", async () => {
    await seed()
    const report = await prisma.$transaction((tx) =>
      runTrialClaimBackfill(tx as unknown as DbTx, false, computeAuditHash)
    )
    const candidateIds = report.candidates.map((c) => c.id)
    expect(candidateIds).toEqual(expect.arrayContaining([ids.stamped, ids.orphan]))
    expect(candidateIds).not.toContain(ids.claimed)
    expect(candidateIds).not.toContain(ids.grantOnly)
    expect(report.cleared).toBe(0)
    expect(report.applied).toBe(false)
    const stamped = await prisma.user.findUnique({ where: { id: ids.stamped } })
    expect(stamped?.trialStartedAt).not.toBeNull()
  })

  it("apply clears wrong stamps, keeps real claims and audits per user", async () => {
    const report = await prisma.$transaction((tx) =>
      runTrialClaimBackfill(tx as unknown as DbTx, true, computeAuditHash)
    )
    expect(report.cleared).toBe(2)
    expect(report.unaudited).toEqual([ids.orphan])

    const [stamped, orphan, claimed, grantOnly] = await Promise.all([
      prisma.user.findUnique({ where: { id: ids.stamped } }),
      prisma.user.findUnique({ where: { id: ids.orphan } }),
      prisma.user.findUnique({ where: { id: ids.claimed } }),
      prisma.user.findUnique({ where: { id: ids.grantOnly } }),
    ])
    expect(stamped?.trialStartedAt).toBeNull()
    expect(orphan?.trialStartedAt).toBeNull()
    expect(claimed?.trialStartedAt).not.toBeNull()
    expect(grantOnly?.trialStartedAt).not.toBeNull()

    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: ids.workspace,
        action: "trial.claim_cleared",
        resourceType: "user",
        resourceId: ids.stamped,
      },
    })
    expect(audit).not.toBeNull()
    expect(audit?.hash?.startsWith("v2:")).toBe(true)
    // No audit row for the orphan — it owns no workspace.
    const orphanAudit = await prisma.auditLog.findFirst({
      where: { workspaceId: ids.workspace, resourceId: ids.orphan },
    })
    expect(orphanAudit).toBeNull()
  })

  it("a second apply run is a no-op", async () => {
    const report = await prisma.$transaction((tx) =>
      runTrialClaimBackfill(tx as unknown as DbTx, true, computeAuditHash)
    )
    expect(report.candidates).toHaveLength(0)
    expect(report.cleared).toBe(0)
  })
})
