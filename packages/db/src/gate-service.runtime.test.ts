import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma"

vi.mock("@lyrashield/config", async (original) => {
  const actual = await original<typeof import("@lyrashield/config")>()
  return {
    ...actual,
    env: {
      ...actual.env,
      DATABASE_URL: process.env.RLS_RUNTIME_DATABASE_URL ?? actual.env.DATABASE_URL,
    },
  }
})
import { handleFixPrMergedAndReevaluate } from "./gate-service"
import { prisma as runtime } from "./client"
import { recordAgentMinutes } from "../../billing/src/usage/meter"
import { debitOverage } from "../../billing/src/usage/overage"
import { enterGrace, GRACE_CAP_MS } from "../../billing/src/grace"

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const id = `money-loop-${randomUUID()}`
let targetId: string
let branch: string
let findingId: string

describe.skipIf(!process.env.RLS_RUNTIME_DATABASE_URL)("automatic retest real RLS recovery", () => {
  beforeAll(async () => {
    const [role] = await runtime.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    await owner.user.create({ data: { id, name: "Money test", email: `${id}@example.invalid` } })
    await owner.workspace.create({ data: { id, name: "Money test", slug: id, plan: "PRO" } })
    await owner.workspaceMember.create({
      data: { workspaceId: id, userId: id, role: "OWNER", status: "active" },
    })
    const target = await owner.target.create({
      data: { workspaceId: id, name: "Test repo", type: "REPO", repoFullName: "test/repo" },
    })
    targetId = target.id
    const scan = await owner.scan.create({
      data: {
        workspaceId: id,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "DEEP",
        status: "COMPLETED",
        createdById: id,
        endedAt: new Date(),
      },
    })
    const finding = await owner.finding.create({
      data: {
        workspaceId: id,
        scanId: scan.id,
        targetId,
        title: "Test finding",
        summary: "Test",
        severity: "HIGH",
        dedupeKey: id,
      },
    })
    findingId = finding.id
    const proposal = await owner.fixProposal.create({ data: { findingId, summary: "Test fix" } })
    branch = `lyrashield/fix-${proposal.id}`
    await owner.pullRequest.create({
      data: {
        fixProposalId: proposal.id,
        provider: "github",
        repoOwner: "test",
        repoName: "repo",
        branchName: branch,
      },
    })
  })
  afterAll(async () => {
    await owner.workspace.deleteMany({ where: { id } })
    await owner.user.deleteMany({ where: { id } })
    await owner.$disconnect()
    await runtime.$disconnect()
  })
  it("creates exactly one scan for concurrent deliveries and resumes it after queue failure", async () => {
    const guard = vi.fn(async () => {})
    const outcomes = await Promise.all([
      handleFixPrMergedAndReevaluate(id, branch, 1, guard),
      handleFixPrMergedAndReevaluate(id, branch, 1, guard),
    ])
    expect(outcomes[0]?.retestScanId).toBeTruthy()
    expect(outcomes[1]?.retestScanId).toBe(outcomes[0]?.retestScanId)
    expect(await owner.scan.count({ where: { workspaceId: id, triggerType: "retest" } })).toBe(1)
    expect(await owner.retest.count({ where: { workspaceId: id, findingId } })).toBe(1)
    expect((await handleFixPrMergedAndReevaluate(id, branch, 1, guard))?.retestScanId).toBe(
      outcomes[0]?.retestScanId
    )
    await owner.scan.update({
      where: { id: outcomes[0]!.retestScanId },
      data: { status: "COMPLETED" },
    })
    expect(await handleFixPrMergedAndReevaluate(id, branch, 1, guard)).toBeNull()
  })
  it("persists PARTIAL elapsed minutes under RLS without charging a failed outcome", async () => {
    await recordAgentMinutes(id, "partial-receipt", 65_000, { outcome: "partial" })
    await recordAgentMinutes(id, "failed-receipt", 65_000, { outcome: "failed" })
    expect(
      await owner.usageRecord.findMany({
        where: { workspaceId: id, kind: "agent_minutes" },
        select: { quantity: true },
      })
    ).toEqual([{ quantity: 2 }])
  })
  it("rolls back minutes, packs and a partial overage debit on budget refusal", async () => {
    await owner.billingAccount.create({
      data: {
        workspaceId: id,
        currentPlan: "LAUNCH_ASSURANCE",
        currentPeriodStart: new Date(0),
        spendLimitCents: 15,
      },
    })
    const pack = await owner.minutePack.create({
      data: {
        workspaceId: id,
        provider: "test",
        externalId: "pack-budget",
        minutes: 3,
        remainingMinutes: 3,
      },
    })
    const count = await owner.usageRecord.count({ where: { workspaceId: id } })
    await expect(
      recordAgentMinutes(id, "budget-refused", 300_000, {
        outcome: "completed",
        settleOverage: async (tx, minutes) => {
          const result = await debitOverage(id, minutes, "budget-refused", "overage", tx)
          if (!result.debited || result.minutes !== minutes) throw new Error("STOPPED_BUDGET")
        },
      })
    ).rejects.toThrow("STOPPED_BUDGET")
    expect(await owner.usageRecord.count({ where: { workspaceId: id } })).toBe(count)
    expect(
      (await owner.minutePack.findUniqueOrThrow({ where: { id: pack.id } })).remainingMinutes
    ).toBe(3)
    expect(
      await owner.usageRecord.count({ where: { workspaceId: id, kind: "overage_minutes" } })
    ).toBe(0)
  })
  it("settles completed minutes and overage once under concurrent replay", async () => {
    await owner.billingAccount.update({
      where: { workspaceId: id },
      data: { spendLimitCents: 1000 },
    })
    const settle = () =>
      recordAgentMinutes(id, "completed-replay", 300_000, {
        outcome: "completed",
        settleOverage: async (tx, minutes) => {
          const result = await debitOverage(id, minutes, "completed-replay", "overage", tx)
          if (!result.debited || result.minutes !== minutes) throw new Error("STOPPED_BUDGET")
        },
      })
    const results = await Promise.all([settle(), settle()])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(
      await owner.usageRecord.count({
        where: { workspaceId: id, idempotencyKey: { contains: "completed-replay" } },
      })
    ).toBe(2)
    expect(
      (
        await owner.minutePack.findFirstOrThrow({
          where: { workspaceId: id, externalId: "pack-budget" },
        })
      ).remainingMinutes
    ).toBe(0)
  })
  it("rolls back pack and minute writes when grace is exhausted", async () => {
    await owner.workspace.update({ where: { id }, data: { graceUsedMs: GRACE_CAP_MS } })
    const pack = await owner.minutePack.create({
      data: {
        workspaceId: id,
        provider: "test",
        externalId: "pack-grace",
        minutes: 1,
        remainingMinutes: 1,
      },
    })
    const count = await owner.usageRecord.count({ where: { workspaceId: id } })
    await expect(
      recordAgentMinutes(id, "grace-refused", 120_000, {
        outcome: "partial",
        settleOverage: async (tx) => {
          if (!(await enterGrace(id, 120_000, tx)).shouldContinue) throw new Error("STOPPED_BUDGET")
        },
      })
    ).rejects.toThrow("STOPPED_BUDGET")
    expect(await owner.usageRecord.count({ where: { workspaceId: id } })).toBe(count)
    expect(
      (await owner.minutePack.findUniqueOrThrow({ where: { id: pack.id } })).remainingMinutes
    ).toBe(1)
  })
})
