/**
 * Monthly generation budget — server-enforced. Spend is recorded as
 * `myra.generate` audit events with `metadata.costUsd`; the cap comes from
 * MYRA_LIMITS.monthlyBudgetUsd, overridable via MYRA_MONTHLY_BUDGET_USD.
 */
import { Prisma, prisma } from "@lyrashield/db"
import { MYRA_LIMITS } from "../contracts"
import { auditEvent } from "./audit"
import { err } from "./errors"
import { resolveCostRates } from "./provider"
import type { MyraDb } from "./db"

export interface BudgetState {
  allowed: boolean
  spentUsd: number
  capUsd: number
}

export function monthlyBudgetCapUsd(): number {
  const override = Number(process.env.MYRA_MONTHLY_BUDGET_USD)
  return Number.isFinite(override) && override > 0 ? override : MYRA_LIMITS.monthlyBudgetUsd
}

export async function checkBudget(db: MyraDb = prisma): Promise<BudgetState> {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const rows = await db.myraAuditEvent.findMany({
    where: { action: "myra.generate", createdAt: { gte: monthStart } },
    select: { metadata: true },
  })
  let spentUsd = 0
  for (const row of rows) {
    const meta = row.metadata as { costUsd?: unknown } | null
    const cost = typeof meta?.costUsd === "number" ? meta.costUsd : 0
    spentUsd += cost
  }
  const capUsd = monthlyBudgetCapUsd()
  return { allowed: spentUsd < capUsd, spentUsd, capUsd }
}

export async function recordCost(
  traceId: string,
  costUsd: number,
  fields: { accountId?: string | null; publicSessionId?: string | null } = {},
  db: MyraDb = prisma
): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  await auditEvent(
    fields.accountId ? "user" : fields.publicSessionId ? "public_session" : "system",
    {
      accountId: fields.accountId ?? null,
      publicSessionId: fields.publicSessionId ?? null,
      action: "myra.generate",
      resourceType: "trace",
      resourceId: traceId,
      metadata: { costUsd },
    },
    db
  )
}

function currentMonthStart(): Date {
  const value = new Date()
  value.setUTCDate(1)
  value.setUTCHours(0, 0, 0, 0)
  return value
}

/** Conservative ceiling: bounded context/user/system input plus the 4k output cap. */
export function maximumTurnCostUsd(tier: "fast" | "deep"): number {
  const { inRate, outRate } = resolveCostRates(tier === "deep")
  const cost = 30 * inRate + (MYRA_LIMITS.maxOutputTokensPerTurn / 1000) * outRate
  return Math.ceil(cost * 10_000) / 10_000
}

export async function reserveGenerationBudget(traceId: string, reservedUsd: number): Promise<void> {
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) {
    throw err("PROVIDER_ERROR", "Generation cost rates are not configured.")
  }
  const capUsd = monthlyBudgetCapUsd()
  const monthStart = currentMonthStart()
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('myra_generation_budget'))`
    )
    const existing = await tx.myraGenerationReservation.findUnique({ where: { traceId } })
    if (existing) {
      throw err("PROVIDER_ERROR", "Generation request was already reserved.")
    }
    const totals = await tx.myraGenerationReservation.aggregate({
      where: { monthStart },
      _sum: { reservedUsd: true, actualUsd: true },
    })
    const settled = Number(totals._sum.actualUsd ?? 0)
    const reserved = Number(totals._sum.reservedUsd ?? 0)
    if (settled + reserved + reservedUsd > capUsd) {
      throw err("BUDGET_EXHAUSTED", "Myra is at its usage limit for now.")
    }
    await tx.myraGenerationReservation.create({
      data: { traceId, monthStart, reservedUsd: new Prisma.Decimal(reservedUsd) },
    })
  })
}

export async function settleGenerationBudget(traceId: string, actualUsd: number): Promise<void> {
  const value = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0
  await prisma.myraGenerationReservation.updateMany({
    where: { traceId, status: "RESERVED" },
    data: {
      actualUsd: new Prisma.Decimal(value),
      reservedUsd: new Prisma.Decimal(0),
      status: value > 0 ? "SETTLED" : "RELEASED",
      settledAt: new Date(),
    },
  })
}
