import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  getSystemPrisma,
  prisma,
  withAccountRLS,
  withWorkspaceRLS,
  type UsageRecord,
} from "@lyrashield/db"
import type { MonthlyPoolGrantParams } from "./usage/grants"
import type { SyncSubscriptionParams } from "./sync"

// The database operations remain real. Inject only a failure after the real
// grant has been written to prove the enclosing PostgreSQL transaction rolls
// back state, retired grants, and workspace display data together.
const fault = vi.hoisted(() => ({ accountId: null as string | null }))
vi.mock("./usage/grants", async (importOriginal) => {
  const original = await importOriginal<typeof import("./usage/grants")>()
  return {
    ...original,
    grantMonthlyPool: async (params: MonthlyPoolGrantParams) => {
      const result = await original.grantMonthlyPool(params)
      if (params.accountId === fault.accountId) throw new Error("injected_after_real_grant")
      return result
    },
  }
})

import { resolveAccountBilling } from "./account"
import { enterGrace } from "./grace"
import { syncSubscription } from "./sync"
import { grantMonthlyPool } from "./usage/grants"
import { getUsageBalanceForTx } from "./usage/balance"

const startedAt = new Date()
const periodStart = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), 1))
const periodEnd = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth() + 1, 1))
const olderTime = new Date(startedAt.getTime() - 3_000)
const newerTime = new Date(startedAt.getTime() - 2_000)
const fixtures: Array<{ accountId: string; workspaceId: string }> = []

interface Fixture {
  accountId: string
  workspaceId: string
  event: SyncSubscriptionParams
}

function requireLocalDatabase(name: string): void {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for this disposable database test`)
  const url = new URL(value)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Disposable loopback databases only")
  }
}

async function fixture(): Promise<Fixture> {
  const accountId = randomUUID()
  const workspaceId = randomUUID()
  // Record only generated IDs, before writes, so a partial fixture failure is
  // also cleaned up without touching any pre-existing rows.
  fixtures.push({ accountId, workspaceId })
  await prisma.user.create({
    data: {
      id: accountId,
      name: "Synthetic billing atomicity",
      email: `${accountId}@example.test`,
    },
  })
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      name: "Synthetic billing atomicity",
      slug: workspaceId,
    },
  })
  return {
    accountId,
    workspaceId,
    event: {
      provider: "polar",
      externalId: `synthetic-${randomUUID()}`,
      accountId,
      workspaceId,
      plan: "PRO",
      status: "active",
      interval: "monthly",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      eventOccurredAt: olderTime,
    },
  }
}

async function snapshot(accountId: string) {
  return withAccountRLS(accountId, async (tx) => ({
    billing: await tx.billingAccount.findMany({ where: { accountId } }),
    // Read retired rows through bounded SQL while preserving account RLS.
    // The ordinary soft-delete read guard intentionally hides retired pools.
    grants: await tx.$queryRaw<UsageRecord[]>`
      SELECT * FROM "UsageRecord"
      WHERE "accountId" = ${accountId} AND kind = 'pool_grant'
      ORDER BY "createdAt", id`,
    effective: await resolveAccountBilling(accountId, tx),
  }))
}

describe.skipIf(
  process.env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1" || process.env.TRIAL_INTEGRATION_TEST !== "1"
)("subscription allowance atomicity with restricted PostgreSQL", () => {
  beforeAll(async () => {
    requireLocalDatabase("DATABASE_URL")
    requireLocalDatabase("DATABASE_SYSTEM_URL")
    const [role] = await prisma.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
  })

  afterAll(async () => {
    fault.accountId = null
    const system = getSystemPrisma()
    try {
      for (const { accountId, workspaceId } of fixtures) {
        await system.$transaction(async (tx) => {
          await tx.usageRecord.deleteMany({ where: { accountId } })
          await tx.billingAccount.deleteMany({ where: { accountId } })
          // Immutable audit history prevents hard workspace deletion. Honor
          // that production guard and remove the synthetic workspace from
          // ordinary reads instead of bypassing the history protection.
          await tx.workspace.updateMany({
            where: { id: workspaceId },
            data: { deletedAt: new Date() },
          })
          await tx.user.deleteMany({ where: { id: accountId } })
        })
      }
    } finally {
      await prisma.$disconnect()
      await system.$disconnect()
    }
  })

  it.each([false, true])(
    "serializes older/newer plan events and preserves replayed grace (newest first: %s)",
    async (newestFirst) => {
      const { accountId, event } = await fixture()
      const newest: SyncSubscriptionParams = {
        ...event,
        plan: "LAUNCH_ASSURANCE",
        eventOccurredAt: newerTime,
      }
      const deliveries = newestFirst ? [newest, event] : [event, newest]
      await Promise.all(deliveries.map(syncSubscription))
      const state = await snapshot(accountId)
      expect(state.billing).toHaveLength(1)
      expect(state.billing[0]).toMatchObject({
        currentPlan: "LAUNCH_ASSURANCE",
        status: "active",
        lastEventAt: newerTime,
      })
      expect(state.grants.filter((grant) => grant.deletedAt === null)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ plan: "LAUNCH_ASSURANCE" }),
        }),
      ])
      await withAccountRLS(accountId, (tx) =>
        tx.billingAccount.updateMany({
          where: { accountId },
          data: { graceUsedMs: 12_345, graceCycleStart: periodStart },
        })
      )
      await syncSubscription(newest)
      expect((await snapshot(accountId)).billing[0]?.graceUsedMs).toBe(12_345)
    }
  )

  it.each([false, true])(
    "cannot restore paid access after concurrent immediate revocation (revoked first: %s)",
    async (revokedFirst) => {
      const { accountId, event } = await fixture()
      const revoked: SyncSubscriptionParams = {
        ...event,
        status: "canceled",
        currentPeriodEnd: newerTime,
        eventOccurredAt: newerTime,
      }
      const deliveries = revokedFirst ? [revoked, event] : [event, revoked]
      await Promise.all(deliveries.map(syncSubscription))
      const state = await snapshot(accountId)
      expect(state.billing[0]).toMatchObject({
        status: "canceled",
        currentPeriodEnd: newerTime,
        lastEventAt: newerTime,
      })
      expect(state.effective?.effectivePlan).toBe("FREE")
      await syncSubscription(event)
      expect((await snapshot(accountId)).grants).toEqual(state.grants)
    }
  )

  it("rolls back after a real grant failure and commits a retry exactly once", async () => {
    const { accountId, workspaceId, event } = await fixture()
    await withAccountRLS(accountId, (tx) =>
      tx.billingAccount.create({
        data: {
          accountId,
          workspaceId,
          purchaseWorkspaceId: workspaceId,
          provider: "polar",
          externalId: event.externalId,
          status: "incomplete",
          currentPlan: "FREE",
        },
      })
    )
    await syncSubscription(event)
    const initial = await snapshot(accountId)
    await withAccountRLS(accountId, (tx) =>
      tx.billingAccount.updateMany({
        where: { accountId },
        data: { graceUsedMs: 12_345, graceCycleStart: periodStart },
      })
    )
    const newest: SyncSubscriptionParams = {
      ...event,
      plan: "LAUNCH_ASSURANCE",
      eventOccurredAt: newerTime,
    }
    fault.accountId = accountId
    try {
      await expect(syncSubscription(newest)).rejects.toThrow("injected_after_real_grant")
    } finally {
      fault.accountId = null
    }
    const rolledBack = await snapshot(accountId)
    expect(rolledBack.billing[0]).toMatchObject({
      currentPlan: "PRO",
      lastEventAt: olderTime,
      graceUsedMs: 12_345,
    })
    expect(rolledBack.grants).toEqual(initial.grants)
    expect((await prisma.workspace.findUnique({ where: { id: workspaceId } }))?.plan).toBe("PRO")
    await syncSubscription(newest)
    const committed = await snapshot(accountId)
    expect(committed.billing[0]).toMatchObject({
      currentPlan: "LAUNCH_ASSURANCE",
      lastEventAt: newerTime,
      graceUsedMs: 12_345,
    })
    expect(committed.grants.filter((grant) => grant.deletedAt === null)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ plan: "LAUNCH_ASSURANCE" }),
      }),
    ])
  })

  it("restores a returning plan's original pool without duplicate credit or lost consumption", async () => {
    const { accountId, event } = await fixture()
    await syncSubscription(event)
    const original = (await snapshot(accountId)).grants[0]!
    await withAccountRLS(accountId, (tx) =>
      tx.usageRecord.create({
        data: {
          accountId,
          kind: "agent_minutes",
          quantity: 7,
          cycleStart: periodStart,
        },
      })
    )
    await syncSubscription({
      ...event,
      plan: "LAUNCH_ASSURANCE",
      eventOccurredAt: newerTime,
    })
    await syncSubscription({
      ...event,
      eventOccurredAt: new Date(startedAt.getTime() - 1_000),
    })
    const state = await snapshot(accountId)
    expect(state.billing[0]?.currentPlan).toBe("PRO")
    expect(state.grants.filter((grant) => grant.deletedAt === null)).toEqual([
      expect.objectContaining({
        id: original.id,
        quantity: original.quantity,
        idempotencyKey: original.idempotencyKey,
      }),
    ])
    expect(
      await withAccountRLS(accountId, (tx) =>
        tx.usageRecord.count({
          where: { accountId, kind: "agent_minutes", quantity: 7 },
        })
      )
    ).toBe(1)
    const balance = await withAccountRLS(accountId, async (tx) =>
      getUsageBalanceForTx(tx, {
        accountId,
        billing: await resolveAccountBilling(accountId, tx),
        trialStartedAt: null,
      })
    )
    expect(balance).toMatchObject({
      poolMinutes: original.quantity,
      poolConsumed: 7,
      poolRemaining: original.quantity - 7,
    })
  })

  it("does not let a stale replenishment snapshot replace the newer plan pool", async () => {
    const { accountId, event } = await fixture()
    await syncSubscription(event)
    const olderBilling = (await snapshot(accountId)).billing[0]!
    await syncSubscription({
      ...event,
      plan: "LAUNCH_ASSURANCE",
      eventOccurredAt: newerTime,
    })
    await grantMonthlyPool({
      accountId,
      billingAccountId: olderBilling.id,
      workspaceId: null,
      plan: "PRO",
      cycleStart: periodStart,
      source: "replenishment",
    })
    const state = await snapshot(accountId)
    expect(state.billing[0]?.currentPlan).toBe("LAUNCH_ASSURANCE")
    expect(state.grants.filter((grant) => grant.deletedAt === null)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ plan: "LAUNCH_ASSURANCE" }),
      }),
    ])
  })

  it("does not restore a revoked complimentary contract's replenished pool", async () => {
    const { accountId, workspaceId } = await fixture()
    const comp = await withAccountRLS(accountId, (tx) =>
      tx.billingAccount.create({
        data: {
          accountId,
          workspaceId: null,
          purchaseWorkspaceId: workspaceId,
          provider: "complimentary",
          externalId: `synthetic-comp-${randomUUID()}`,
          status: "active",
          currentPlan: "LAUNCH_ASSURANCE",
          interval: "monthly",
          currentPeriodStart: periodStart,
        },
      })
    )
    const params: MonthlyPoolGrantParams = {
      accountId,
      billingAccountId: comp.id,
      workspaceId: null,
      plan: "LAUNCH_ASSURANCE",
      cycleStart: periodStart,
      source: "replenishment",
    }
    await grantMonthlyPool(params)
    await withAccountRLS(accountId, async (tx) => {
      await tx.billingAccount.update({
        where: { id: comp.id, accountId },
        data: {
          status: "downgraded",
          currentPlan: "FREE",
          deletedAt: new Date(),
        },
      })
      await tx.usageRecord.updateMany({
        where: {
          accountId,
          kind: "pool_grant",
          metadata: { path: ["billingAccountId"], equals: comp.id },
        },
        data: { deletedAt: new Date() },
      })
    })
    await grantMonthlyPool(params)
    expect((await snapshot(accountId)).grants.filter((grant) => grant.deletedAt === null)).toEqual(
      []
    )
  })

  it("keeps account-only grace available inside a scan workspace transaction", async () => {
    const { accountId, workspaceId, event } = await fixture()
    await syncSubscription(event)
    const result = await withWorkspaceRLS(workspaceId, (tx) => enterGrace(accountId, 1_000, tx), {
      accountId,
    })
    expect(result.shouldContinue).toBe(true)
    expect((await snapshot(accountId)).billing[0]?.graceUsedMs).toBe(1_000)
  })

  it("preserves spent grace when the plan changes inside the same allowance cycle", async () => {
    const { accountId, event } = await fixture()
    await syncSubscription(event)
    await withAccountRLS(accountId, (tx) =>
      tx.billingAccount.updateMany({
        where: { accountId },
        data: { graceUsedMs: 12_345, graceCycleStart: periodStart },
      })
    )
    await syncSubscription({
      ...event,
      plan: "LAUNCH_ASSURANCE",
      eventOccurredAt: newerTime,
    })
    expect((await snapshot(accountId)).billing[0]?.graceUsedMs).toBe(12_345)
  })
})
