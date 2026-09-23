import "./test-env"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"

/**
 * Generation-budget ledger tests — real Postgres, with the caller context
 * bound as the restricted NOBYPASSRLS runtime role.
 *
 * The v18 defect: checkBudget() summed myra.generate audit rows through the
 * caller's possibly-bound db handle — under a bound principal that read sees
 * zero rows and the pre-gate never engages; and a provider throw between
 * reserve and settle left the row RESERVED for retention to charge at the
 * ceiling. The reservation table is the single ledger now: a definite
 * provider failure releases the hold, a timeout keeps it for the retention
 * sweep and the cap still rejects when the caller runs bound. The suite
 * skips loudly when RLS_RUNTIME_DATABASE_URL is absent.
 */
import { env } from "@lyrashield/config"
import { Prisma, createBoundedPgAdapter } from "@lyrashield/db"
import { PrismaClient } from "@lyrashield/db/src/generated/prisma"
import { MYRA_LIMITS, type MyraStreamEvent } from "../contracts"
import { maximumTurnCostUsd, monthlyBudgetCapUsd } from "./budget"
import { err } from "./errors"
import { runTaskLoop } from "./loop"
import type { ModelProvider } from "./provider"
import type { MyraDb } from "./db"
import type { MyraToolContext } from "./tools/types"

const runtimeUrl = process.env.RLS_RUNTIME_DATABASE_URL
if (!runtimeUrl) {
  console.warn(
    "[budget.test] SKIPPED: RLS_RUNTIME_DATABASE_URL is not set. These assertions run " +
      "against real Postgres as the restricted runtime role; provide a NOBYPASSRLS " +
      "connection string to exercise them."
  )
}

/** The restricted application role — bound transactions are Postgres-enforced. */
const runtime = runtimeUrl
  ? new PrismaClient({ adapter: createBoundedPgAdapter(runtimeUrl) })
  : null

const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
const ENV_KEYS = [
  "MYRA_MONTHLY_BUDGET_USD",
  "MYRA_COST_PER_1K_INPUT_USD",
  "MYRA_COST_PER_1K_OUTPUT_USD",
] as const
const mutableEnv = env as unknown as Record<(typeof ENV_KEYS)[number], string | undefined>

it("never raises the Myra monthly cap above $50", () => {
  const prior = mutableEnv.MYRA_MONTHLY_BUDGET_USD
  try {
    mutableEnv.MYRA_MONTHLY_BUDGET_USD = "500"
    expect(monthlyBudgetCapUsd()).toBe(MYRA_LIMITS.monthlyBudgetUsd)
  } finally {
    mutableEnv.MYRA_MONTHLY_BUDGET_USD = prior
  }
})

function firstOfMonth(): Date {
  const value = new Date()
  value.setUTCDate(1)
  value.setUTCHours(0, 0, 0, 0)
  return value
}

function baseCtx(db?: MyraDb): MyraToolContext {
  return {
    principal: {
      kind: "user",
      accountId: `budget-acct-${suffix}`,
      sessionId: `budget-sess-${suffix}`,
      workspaceId: null,
      role: null,
    },
    surface: "DASHBOARD",
    conversationId: null,
    workspaceId: null,
    role: null,
    ...(db ? { db } : {}),
  }
}

function azureStub(generate: ModelProvider["generate"]): ModelProvider {
  return { name: "azure", generate }
}

async function drain(gen: AsyncGenerator<MyraStreamEvent>): Promise<MyraStreamEvent[]> {
  const events: MyraStreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function errorCode(events: MyraStreamEvent[]): string | null {
  const event = events.find((e) => e.type === "error")
  return event && event.type === "error" ? event.error.code : null
}

describe.skipIf(!runtimeUrl || !runtime)("generation budget ledger", () => {
  const traceIds: string[] = []
  const savedEnv = new Map<string, string | undefined>()

  beforeAll(async () => {
    if (!runtime) return
    // Guard the false-assurance case: under a BYPASSRLS/superuser role the
    // bound-context assertions below would pass vacuously.
    const [role] = await runtime.$queryRaw<
      Array<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>
    >`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`
    expect(role).toMatchObject({ rolbypassrls: false, rolsuper: false })
  })

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, mutableEnv[key])
    mutableEnv.MYRA_COST_PER_1K_INPUT_USD = "0.001"
    mutableEnv.MYRA_COST_PER_1K_OUTPUT_USD = "0.002"
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      mutableEnv[key] = savedEnv.get(key)
    }
    savedEnv.clear()
    if (runtime && traceIds.length > 0) {
      await runtime.myraGenerationReservation.deleteMany({
        where: { traceId: { in: traceIds.splice(0) } },
      })
    }
  })

  afterAll(async () => {
    await runtime?.$disconnect()
  })

  it("releases the reservation when the provider definitely fails", async () => {
    const { ProviderDefiniteFailure } = await import("./provider")
    const traceId = `budget-definite-${suffix}`
    traceIds.push(traceId)
    const generate = vi
      .fn()
      .mockRejectedValue(
        typeof ProviderDefiniteFailure === "function"
          ? new ProviderDefiniteFailure("Generation provider request failed.")
          : err("PROVIDER_ERROR", "Generation provider request failed.")
      )

    const events = await drain(
      runTaskLoop({
        ctx: baseCtx(),
        text: "How do I export a report?",
        assistantMessageId: `msg-${suffix}-a`,
        traceId,
        provider: azureStub(generate),
      })
    )

    expect(ProviderDefiniteFailure, "provider must export ProviderDefiniteFailure").toBeTypeOf(
      "function"
    )
    expect(errorCode(events)).toBe("PROVIDER_ERROR")
    expect(generate).toHaveBeenCalledTimes(1)
    const row = await runtime!.myraGenerationReservation.findUnique({ where: { traceId } })
    expect(row?.status).toBe("RELEASED")
    expect(Number(row?.reservedUsd)).toBe(0)
    expect(row?.actualUsd).toBeNull()
  })

  it("keeps the reservation RESERVED on a provider timeout for retention settlement", async () => {
    const { ProviderTimeout } = await import("./provider")
    const traceId = `budget-timeout-${suffix}`
    traceIds.push(traceId)
    const generate = vi
      .fn()
      .mockRejectedValue(
        typeof ProviderTimeout === "function"
          ? new ProviderTimeout("Generation provider request timed out.")
          : err("PROVIDER_ERROR", "Generation provider request timed out.")
      )

    const events = await drain(
      runTaskLoop({
        ctx: baseCtx(),
        text: "How do I export a report?",
        assistantMessageId: `msg-${suffix}-b`,
        traceId,
        provider: azureStub(generate),
      })
    )

    expect(ProviderTimeout, "provider must export ProviderTimeout").toBeTypeOf("function")
    expect(errorCode(events)).toBe("PROVIDER_ERROR")
    expect(generate).toHaveBeenCalledTimes(1)
    const row = await runtime!.myraGenerationReservation.findUnique({ where: { traceId } })
    expect(row?.status).toBe("RESERVED")
    expect(Number(row?.reservedUsd)).toBeCloseTo(maximumTurnCostUsd("fast"), 6)
    expect(row?.actualUsd).toBeNull()
  })

  it("rejects with BUDGET_EXHAUSTED for a bound principal when settled spend fills the cap", async () => {
    mutableEnv.MYRA_MONTHLY_BUDGET_USD = "0.05"
    const seedTraceId = `budget-seed-${suffix}`
    const traceId = `budget-cap-${suffix}`
    traceIds.push(seedTraceId, traceId)
    await runtime!.myraGenerationReservation.create({
      data: {
        traceId: seedTraceId,
        monthStart: firstOfMonth(),
        reservedUsd: new Prisma.Decimal(0),
        actualUsd: new Prisma.Decimal("0.02"),
        status: "SETTLED",
        settledAt: new Date(),
      },
    })
    const generate = vi.fn().mockResolvedValue({
      text: "answer",
      usage: { inTokens: 0, outTokens: 0, costUsd: 0 },
    })

    // The whole turn runs inside the caller's bound RLS transaction — where
    // the retired audit-row read saw zero rows and waved spend through.
    const events = await runtime!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
      await tx.$executeRaw`SELECT set_config('app.current_account_id', ${`budget-acct-${suffix}`}, true)`
      return drain(
        runTaskLoop({
          ctx: baseCtx(tx as never),
          text: "How do I export a report?",
          assistantMessageId: `msg-${suffix}-c`,
          traceId,
          provider: azureStub(generate),
        })
      )
    })

    expect(errorCode(events)).toBe("BUDGET_EXHAUSTED")
    expect(generate).not.toHaveBeenCalled()
    const row = await runtime!.myraGenerationReservation.findUnique({ where: { traceId } })
    expect(row).toBeNull()
  })

  it("reports month spend as SUM(actualUsd) for operators", async () => {
    const { monthlyGenerationSpendUsd } = await import("./budget")
    expect(monthlyGenerationSpendUsd, "budget must export monthlyGenerationSpendUsd").toBeTypeOf(
      "function"
    )
    const before = await monthlyGenerationSpendUsd()
    const first = `budget-spend-a-${suffix}`
    const second = `budget-spend-b-${suffix}`
    traceIds.push(first, second)
    for (const [id, usd] of [
      [first, "0.01"],
      [second, "0.02"],
    ] as const) {
      await runtime!.myraGenerationReservation.create({
        data: {
          traceId: id,
          monthStart: firstOfMonth(),
          reservedUsd: new Prisma.Decimal(0),
          actualUsd: new Prisma.Decimal(usd),
          status: "SETTLED",
          settledAt: new Date(),
        },
      })
    }

    expect(await monthlyGenerationSpendUsd()).toBeCloseTo(before + 0.03, 6)
  })
})
