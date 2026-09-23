/**
 * Monthly generation budget — server-enforced. The reservation table is the
 * single ledger: a RESERVED row holds the conservative ceiling across the
 * provider call, settleGenerationBudget swaps the hold for actualUsd on
 * success, releaseGenerationBudget returns it on a definite provider
 * failure and the retention sweep settles stale RESERVED rows at the
 * ceiling. The cap comes from MYRA_LIMITS.monthlyBudgetUsd, overridable via
 * MYRA_MONTHLY_BUDGET_USD.
 *
 * Every ledger read/write runs on the unbound client on purpose: the
 * reservations RLS policy is unbound-only, so a bound owner context must
 * never carry these calls (it would see zero rows and wave spend through).
 */
import { Prisma, getSystemPrisma } from "@lyrashield/db"
import { env } from "@lyrashield/config"
import { MYRA_LIMITS } from "../contracts"
import { err } from "./errors"
import { MYRA_LUNA_USD_PER_MILLION } from "./provider"

export function monthlyBudgetCapUsd(): number {
  const override = Number(env.MYRA_MONTHLY_BUDGET_USD)
  return Number.isFinite(override) && override > 0
    ? Math.min(override, MYRA_LIMITS.monthlyBudgetUsd)
    : MYRA_LIMITS.monthlyBudgetUsd
}

function currentMonthStart(): Date {
  const value = new Date()
  value.setUTCDate(1)
  value.setUTCHours(0, 0, 0, 0)
  return value
}

/** Operator-facing month-to-date generation spend — settled ledger rows only. */
export async function monthlyGenerationSpendUsd(): Promise<number> {
  const totals = await getSystemPrisma().myraGenerationReservation.aggregate({
    where: { monthStart: currentMonthStart() },
    _sum: { actualUsd: true },
  })
  return Number(totals._sum.actualUsd ?? 0)
}

/** Conservative ceiling: bounded context/user/system input plus the 4k output cap. */
export function maximumTurnCostUsd(): number {
  // Cache writes cost more than uncached input; reserve the worst case.
  const cost =
    (30_000 * MYRA_LUNA_USD_PER_MILLION.cacheWriteInput +
      MYRA_LIMITS.maxOutputTokensPerTurn * MYRA_LUNA_USD_PER_MILLION.output) /
    1_000_000
  return Math.ceil(cost * 10_000) / 10_000
}

export async function reserveGenerationBudget(traceId: string, reservedUsd: number): Promise<void> {
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) {
    throw err("PROVIDER_ERROR", "Generation cost rates are not configured.")
  }
  const capUsd = monthlyBudgetCapUsd()
  const monthStart = currentMonthStart()
  await getSystemPrisma().$transaction(async (tx) => {
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
  await getSystemPrisma().myraGenerationReservation.updateMany({
    where: { traceId, status: "RESERVED" },
    data: {
      actualUsd: new Prisma.Decimal(value),
      reservedUsd: new Prisma.Decimal(0),
      status: value > 0 ? "SETTLED" : "RELEASED",
      settledAt: new Date(),
    },
  })
}

/**
 * Return a reservation hold after a failure where no generation could have
 * happened (a non-2xx response or a thrown error before any request was
 * sent). A timeout is NOT definite — the request may have completed
 * upstream — so callers leave those rows RESERVED for the retention sweep.
 */
export async function releaseGenerationBudget(traceId: string): Promise<void> {
  await getSystemPrisma().myraGenerationReservation.updateMany({
    where: { traceId, status: "RESERVED" },
    data: {
      reservedUsd: new Prisma.Decimal(0),
      status: "RELEASED",
      settledAt: new Date(),
    },
  })
}
