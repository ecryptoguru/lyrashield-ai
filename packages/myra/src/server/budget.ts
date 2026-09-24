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

/**
 * Share of the monthly pool that signed-in callers keep for themselves.
 * Anonymous visitors can spend the pool only up to this fraction, so one IP
 * that clears Turnstile cannot exhaust the month and lock paying customers
 * out of generation until the month rolls over. Availability, not cost: the
 * total spend stays under the cap either way.
 */
export const ANONYMOUS_POOL_SHARE = 0.7

/** Fraction of the pool at which the operator warning fires, once per month. */
export const POOL_WARNING_THRESHOLD = 0.8

/**
 * Month-to-date committed spend — settled plus the holds still outstanding
 * across provider calls. The anonymous share must count holds too, or a burst
 * of concurrent anonymous turns each read the same pre-burst total.
 */
async function committedSpendUsd(): Promise<number> {
  const totals = await getSystemPrisma().myraGenerationReservation.aggregate({
    where: { monthStart: currentMonthStart() },
    _sum: { actualUsd: true, reservedUsd: true },
  })
  return Number(totals._sum.actualUsd ?? 0) + Number(totals._sum.reservedUsd ?? 0)
}

/**
 * Refuse an anonymous generation once the anonymous share of the pool is
 * spent. Checked before reserveGenerationBudget so the rejection carries the
 * budget error shape rather than the generic reservation failure.
 */
export async function assertAnonymousBudgetAvailable(): Promise<void> {
  const capUsd = monthlyBudgetCapUsd()
  const spentUsd = await committedSpendUsd()
  if (spentUsd >= capUsd * ANONYMOUS_POOL_SHARE) {
    throw err("BUDGET_EXHAUSTED", "Myra is at its usage limit for now.")
  }
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
    const committedBefore = settled + reserved
    const committedAfter = committedBefore + reservedUsd
    if (committedAfter > capUsd) {
      throw err("BUDGET_EXHAUSTED", "Myra is at its usage limit for now.")
    }
    await tx.myraGenerationReservation.create({
      data: { traceId, monthStart, reservedUsd: new Prisma.Decimal(reservedUsd) },
    })
    // Operator alert at 80 percent of the pool. The advisory lock above
    // serializes reservations, so exactly one transaction observes the
    // threshold being crossed within a month — this fires once per month
    // without a new column or a migration.
    const warningAt = capUsd * POOL_WARNING_THRESHOLD
    if (committedBefore < warningAt && committedAfter >= warningAt) {
      // This package has no logger dependency (dependency direction), so the
      // operator-visible signal it can emit is a structured console warning.
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "myra.generation_pool_near_cap",
          monthStart: monthStart.toISOString(),
          committedUsd: Math.round(committedAfter * 100) / 100,
          capUsd,
          threshold: POOL_WARNING_THRESHOLD,
        })
      )
    }
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
