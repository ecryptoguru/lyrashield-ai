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
import {
  recordAgentMinutes,
  hasUnsettledScanIntent,
  type RecordAgentMinutesOptions,
} from "../../billing/src/usage/meter"
import { debitOverage } from "../../billing/src/usage/overage"
import { enterGrace, GRACE_CAP_MS } from "../../billing/src/grace"
import * as rls from "./rls"
import { completeScanWithScore } from "./score-service"
import {
  persistResultManifest,
  completeRetestsForScan,
} from "../../../apps/worker/src/engine/result-integrity"

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
  it("rolls back scan and retest together on a late outer transaction failure, then recovers", async () => {
    const source = await owner.scan.findFirstOrThrow({
      where: { workspaceId: id, status: "COMPLETED" },
    })
    const finding = await owner.finding.create({
      data: {
        workspaceId: id,
        targetId,
        scanId: source.id,
        title: "Late failure",
        summary: "Test",
        severity: "HIGH",
        dedupeKey: `${id}-late`,
      },
    })
    const proposal = await owner.fixProposal.create({
      data: { findingId: finding.id, summary: "Fix" },
    })
    const recoveryBranch = `${branch}-late`
    await owner.pullRequest.create({
      data: {
        fixProposalId: proposal.id,
        provider: "github",
        repoOwner: "test",
        repoName: "repo",
        branchName: recoveryBranch,
      },
    })
    const count = await owner.scan.count({ where: { workspaceId: id } })
    const original = rls.withWorkspaceRLS
    let inject = true
    const spy = vi
      .spyOn(rls, "withWorkspaceRLS")
      .mockImplementation((workspaceId, callback, options) =>
        original(
          workspaceId,
          async (tx) => {
            const result = await callback(tx)
            if (inject && options?.timeout === 30_000) {
              inject = false
              throw new Error("late transaction failure")
            }
            return result
          },
          options
        )
      )
    try {
      await expect(
        handleFixPrMergedAndReevaluate(id, recoveryBranch, 2, async () => {})
      ).rejects.toThrow("late transaction failure")
    } finally {
      spy.mockRestore()
    }
    expect(await owner.scan.count({ where: { workspaceId: id } })).toBe(count)
    expect(await owner.retest.count({ where: { workspaceId: id, findingId: finding.id } })).toBe(0)
    const recovered = await handleFixPrMergedAndReevaluate(id, recoveryBranch, 2, async () => {})
    expect(recovered?.retestScanId).toBeTruthy()
    expect(await owner.scan.count({ where: { workspaceId: id } })).toBe(count + 1)
    await owner.scan.update({
      where: { id: recovered!.retestScanId },
      data: { status: "COMPLETED" },
    })
  })
  it("rolls back provisional charges when result persistence fails and recovers without engine work", async () => {
    const scan = await owner.scan.create({
      data: {
        workspaceId: id,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        status: "VERIFYING",
        createdById: id,
      },
    })
    const beforeUsage = await owner.usageRecord.count({ where: { workspaceId: id } })
    const beforePacks = await owner.minutePack.findMany({
      where: { workspaceId: id },
      select: { id: true, remainingMinutes: true },
      orderBy: { id: "asc" },
    })
    const manifestInput = {
      scanId: scan.id,
      target: { id: targetId, type: "REPO" as const },
      sourceCheckoutAvailable: true,
      engineFindingCount: 0,
      coverageIssues: [],
    }
    const options: RecordAgentMinutesOptions = {
      outcome: "completed",
      settleOverage: async (tx, minutes) => {
        const debit = await debitOverage(id, minutes, scan.id, "final", tx)
        if (debit.minutes !== minutes) throw new Error("STOPPED_BUDGET")
      },
    }
    await expect(
      recordAgentMinutes(id, scan.id, 120_000, {
        ...options,
        beforeCommit: async () => {
          await persistResultManifest(manifestInput)
          throw new Error("retest persistence unavailable")
        },
      })
    ).rejects.toThrow("retest persistence unavailable")
    expect(await owner.usageRecord.count({ where: { workspaceId: id } })).toBe(beforeUsage)
    expect(
      await owner.minutePack.findMany({
        where: { workspaceId: id },
        select: { id: true, remainingMinutes: true },
        orderBy: { id: "asc" },
      })
    ).toEqual(beforePacks)
    expect(await owner.scanResultManifest.findUnique({ where: { scanId: scan.id } })).not.toBeNull()
    // Retry only the durable result tail. There is no scanner/provider call.
    await recordAgentMinutes(id, scan.id, 120_000, {
      ...options,
      beforeCommit: async () => {
        await persistResultManifest(manifestInput)
        await completeRetestsForScan({ scanId: scan.id, workspaceId: id })
        await completeScanWithScore(scan.id, id, "Recovered result")
      },
    })
    expect(await hasUnsettledScanIntent(id, scan.id)).toBe(false)
    expect((await owner.scan.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe(
      "COMPLETED"
    )
    expect(
      await owner.usageRecord.count({
        where: { workspaceId: id, idempotencyKey: { contains: scan.id } },
      })
    ).toBe(2)
    const failed = await owner.scan.create({
      data: {
        workspaceId: id,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        status: "VERIFYING",
        createdById: id,
      },
    })
    const balanceBeforeFailure = await owner.minutePack.findMany({
      where: { workspaceId: id },
      select: { id: true, remainingMinutes: true },
      orderBy: { id: "asc" },
    })
    const graceBeforeFailure = (await owner.workspace.findUniqueOrThrow({ where: { id } }))
      .graceUsedMs
    const usageBeforeFailure = await owner.usageRecord.count({ where: { workspaceId: id } })
    await expect(
      recordAgentMinutes(id, failed.id, 120_000, {
        outcome: "completed",
        beforeCommit: async () => {
          throw new Error("manifest storage unavailable")
        },
      })
    ).rejects.toThrow("manifest storage unavailable")
    await rls.withWorkspaceRLS(id, (tx) =>
      tx.scan.update({ where: { id: failed.id }, data: { status: "FAILED" } })
    )
    expect((await owner.scan.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED")
    expect(await owner.usageRecord.count({ where: { workspaceId: id } })).toBe(usageBeforeFailure)
    expect(
      await owner.minutePack.findMany({
        where: { workspaceId: id },
        select: { id: true, remainingMinutes: true },
        orderBy: { id: "asc" },
      })
    ).toEqual(balanceBeforeFailure)
    expect((await owner.workspace.findUniqueOrThrow({ where: { id } })).graceUsedMs).toBe(
      graceBeforeFailure
    )
    const terminal = await owner.scan.create({
      data: {
        workspaceId: id,
        targetId,
        goal: "LAUNCH_REVIEW",
        mode: "SAFE",
        status: "VERIFYING",
        createdById: id,
      },
    })
    await expect(
      recordAgentMinutes(id, terminal.id, 60_000, {
        outcome: "completed",
        beforeCommit: async () => {
          await persistResultManifest({ ...manifestInput, scanId: terminal.id })
          await completeRetestsForScan({ scanId: terminal.id, workspaceId: id })
          await completeScanWithScore(terminal.id, id, "Durable before monetary commit")
          throw new Error("injected monetary commit failure")
        },
      })
    ).rejects.toThrow("injected monetary commit failure")
    // Independent intent survives the actual settlement rollback. A fresh
    // recovery read needs no process-local marker and never mutates money.
    expect(await hasUnsettledScanIntent(id, terminal.id)).toBe(true)
    expect(
      await owner.scanEvent.count({
        where: { scanId: terminal.id, stage: "billing_settlement_intent" },
      })
    ).toBe(1)
    expect((await owner.scan.findUniqueOrThrow({ where: { id: terminal.id } })).status).toBe(
      "COMPLETED"
    )
    expect(await owner.scoreSnapshot.findUnique({ where: { scanId: terminal.id } })).not.toBeNull()
    expect(await owner.usageRecord.count({ where: { workspaceId: id } })).toBe(usageBeforeFailure)
  })
})
