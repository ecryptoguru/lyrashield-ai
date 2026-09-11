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
import { grantMonthlyPool } from "../../billing/src/usage/grants"
import { getUsageBalance } from "../../billing/src/usage/balance"
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})
const accountId = `allowance-${randomUUID()}`
const august = new Date("2026-08-01T00:00:00Z")
const september = new Date("2026-09-01T00:00:00Z")
describe.skipIf(!process.env.RLS_RUNTIME_DATABASE_URL)("account allowance real PostgreSQL", () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"))
    await owner.user.create({
      data: {
        id: accountId,
        email: `${accountId}@example.invalid`,
        name: "Allowance test",
        emailVerified: true,
      },
    })
    await owner.billingAccount.create({
      data: {
        accountId,
        workspaceId: null,
        provider: "polar",
        externalId: accountId,
        currentPlan: "LAUNCH_ASSURANCE",
        status: "active",
        interval: "annual",
        currentPeriodStart: august,
        currentPeriodEnd: new Date("2027-08-01T00:00:00Z"),
      },
    })
  })
  afterAll(async () => {
    vi.useRealTimers()
    await owner.$disconnect()
  })
  it("renews month two once, without a workspace, preserving month-one consumption", async () => {
    await grantMonthlyPool({
      accountId,
      workspaceId: null,
      plan: "LAUNCH_ASSURANCE",
      cycleStart: august,
      source: "annual_monthly",
    })
    await owner.usageRecord.create({
      data: {
        accountId,
        workspaceId: null,
        kind: "agent_minutes",
        quantity: 6000,
        cycleStart: august,
      },
    })
    const results = await Promise.all(
      [1, 2].map(() =>
        grantMonthlyPool({
          accountId,
          workspaceId: null,
          plan: "LAUNCH_ASSURANCE",
          cycleStart: september,
          source: "annual_monthly",
        })
      )
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await getUsageBalance(accountId)).toMatchObject({
      poolMinutes: 6000,
      poolConsumed: 0,
      totalRemaining: 6000,
      cycleStart: september,
    })
    expect(await owner.usageRecord.count({ where: { accountId, kind: "agent_minutes" } })).toBe(1)
  })
})
