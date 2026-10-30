import {
  bindAccountRLSContext,
  lockUserScanAdmission,
  withWorkspaceRLS,
  type ScopedTransaction,
} from "@lyrashield/db"
import { STANDARD_OVERAGE_PER_MINUTE_USD } from "@lyrashield/pricing"
import { resolveAccountBilling } from "../account"
import { GRACE_CAP_MS } from "../grace"
import { getUsageBalanceForTx } from "./balance"

const RATE_CENTS = Math.round(STANDARD_OVERAGE_PER_MINUTE_USD * 100)
const HELD = ["RESERVED", "RUNNING", "REVIEW_REQUIRED"]
export class ScanCapacityWaitingError extends Error {
  constructor() {
    super("Waiting for account review capacity")
    this.name = "ScanCapacityWaitingError"
  }
}
export const CAPACITY_STOP_MARGIN_MS = 5_000

type PackAllocation = { id: string; minutes: number }
function allocations(value: unknown): PackAllocation[] {
  if (!Array.isArray(value)) throw new Error("invalid_capacity_pack_receipt")
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      !("minutes" in item) ||
      typeof item.id !== "string" ||
      typeof item.minutes !== "number" ||
      !Number.isSafeInteger(item.minutes) ||
      item.minutes < 0
    )
      throw new Error("invalid_capacity_pack_receipt")
    return { id: item.id, minutes: item.minutes }
  })
}

export function fundedRuntimeMs(minutes: number, multiplier: number, limitMs: number): number {
  return Math.max(
    0,
    Math.min(limitMs, Math.floor(minutes / multiplier) * 60_000 - CAPACITY_STOP_MARGIN_MS)
  )
}

async function lockedScan(tx: ScopedTransaction, workspaceId: string, scanId: string) {
  const scan = await tx.scan.findFirst({ where: { id: scanId, workspaceId } })
  if (!scan) throw new Error("capacity_scan_not_found")
  await lockUserScanAdmission(tx, scan.createdById)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
  const accountId = scan.sponsorAccountId ?? scan.createdById
  await bindAccountRLSContext(tx, accountId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${accountId}`}, 0))`
  const current = await tx.scan.findFirst({ where: { id: scanId, workspaceId } })
  if (
    !current ||
    current.createdById !== scan.createdById ||
    (current.sponsorAccountId ?? current.createdById) !== accountId
  )
    throw new Error("capacity_scan_identity_changed")
  return { scan: current, accountId }
}

export type CapacityAdmission =
  | { state: "LEGACY" }
  | { state: "WAITING" }
  | { state: "RUNNING" | "RESERVED"; runtimeLimitMs: number; fundedMinutes: number }

/** Re-evaluate immediately before the provider starts. Waiting holds no funds. */
export async function reserveScanCapacity(input: {
  workspaceId: string
  scanId: string
  maxRuntimeMs: number
  start?: boolean
}): Promise<CapacityAdmission> {
  if (!Number.isFinite(input.maxRuntimeMs) || input.maxRuntimeMs <= 0)
    throw new Error("invalid_capacity_runtime")
  return withWorkspaceRLS(input.workspaceId, async (tx) => {
    const { scan, accountId } = await lockedScan(tx, input.workspaceId, input.scanId)
    if (scan.accountingVersion !== 2) return { state: "LEGACY" }
    if (!["QUEUED", "PREFLIGHT", "RUNNING"].includes(scan.status))
      throw new Error("capacity_scan_not_executable")
    const reservation = await tx.scanCapacityReservation.findUnique({ where: { scanId: scan.id } })
    if (
      !reservation ||
      reservation.accountId !== accountId ||
      reservation.userId !== scan.createdById
    )
      throw new Error("capacity_identity_mismatch")
    if (!["WAITING", "RESERVED"].includes(reservation.state))
      throw new Error("capacity_execution_already_started")
    const waitWithoutFunding = async (): Promise<CapacityAdmission> => {
      await tx.scanCapacityReservation.update({
        where: { scanId: scan.id },
        data: {
          state: "WAITING",
          poolMinutes: 0,
          packMinutes: 0,
          packAllocations: [],
          graceMinutes: 0,
          overageMinutes: 0,
          fundedMinutes: 0,
          runtimeLimitMs: 0,
          cycleStart: null,
          billingAccountId: null,
        },
      })
      return { state: "WAITING" }
    }
    const held = await tx.scanCapacityReservation.findMany({
      where: {
        accountId,
        scanId: { not: scan.id },
        OR: [{ state: { in: HELD } }, { state: "SETTLED", stoppedAt: null }],
      },
    })
    if (held.some((row) => row.state === "REVIEW_REQUIRED")) return waitWithoutFunding()
    const first = await tx.scanCapacityReservation.findFirst({
      where: { accountId, state: "WAITING" },
      orderBy: [{ createdAt: "asc" }, { scanId: "asc" }],
    })
    if (reservation.state === "WAITING" && first?.scanId !== scan.id) return { state: "WAITING" }
    const billing = await resolveAccountBilling(accountId, tx)
    const user = await tx.user.findUnique({
      where: { id: accountId },
      select: { trialStartedAt: true },
    })
    const balance = await getUsageBalanceForTx(tx, {
      accountId,
      billing,
      trialStartedAt: user?.trialStartedAt ?? null,
    })
    const sameCycle = held.filter((r) => r.cycleStart?.getTime() === balance.cycleStart?.getTime())
    let pool = Math.max(0, balance.poolRemaining - sameCycle.reduce((n, r) => n + r.poolMinutes, 0))
    const heldPacks = new Map<string, number>()
    for (const row of held)
      for (const pack of allocations(row.packAllocations))
        heldPacks.set(pack.id, (heldPacks.get(pack.id) ?? 0) + pack.minutes)
    const eligibleOverage =
      billing?.effectivePlan === "LAUNCH_ASSURANCE" && (billing.spendLimitCents ?? 0) > 0
    let overage = eligibleOverage
      ? Math.max(
          0,
          Math.floor(
            (billing!.spendLimitCents! - balance.overageConsumed * RATE_CENTS) / RATE_CENTS
          ) - sameCycle.reduce((n, r) => n + r.overageMinutes, 0)
        )
      : 0
    let grace =
      !eligibleOverage && billing
        ? Math.max(
            0,
            Math.floor((GRACE_CAP_MS - billing.graceUsedMs) / 60_000) -
              sameCycle.reduce((n, r) => n + r.graceMinutes, 0)
          )
        : 0
    // The stored execution plan may only be narrowed by current policy/profile.
    const plan = scan.executionPlan as { limits?: { maxEngineMs?: number } } | null
    const limitMs = Math.min(input.maxRuntimeMs, plan?.limits?.maxEngineMs ?? input.maxRuntimeMs)
    let needed = Math.ceil(limitMs / 60_000) * reservation.multiplier
    pool = Math.min(pool, needed)
    needed -= pool
    const packs: PackAllocation[] = []
    for (const pack of balance.packs) {
      const minutes = Math.min(
        needed,
        Math.max(0, pack.remainingMinutes - (heldPacks.get(pack.id) ?? 0))
      )
      if (minutes) packs.push({ id: pack.id, minutes })
      needed -= minutes
    }
    overage = Math.min(overage, needed)
    needed -= overage
    grace = Math.min(grace, needed)
    // Do not reserve a fractional Deep minute: 5 units can fund only one
    // complete 3-unit minute. Return the unusable tail to the shared account.
    let remainder =
      (pool + packs.reduce((n, p) => n + p.minutes, 0) + grace + overage) % reservation.multiplier
    const graceTail = Math.min(grace, remainder)
    grace -= graceTail
    remainder -= graceTail
    const overageTail = Math.min(overage, remainder)
    overage -= overageTail
    remainder -= overageTail
    for (const pack of [...packs].reverse()) {
      const tail = Math.min(pack.minutes, remainder)
      pack.minutes -= tail
      remainder -= tail
    }
    pool -= remainder
    const packMinutes = packs.reduce((n, p) => n + p.minutes, 0)
    const fundedMinutes = pool + packMinutes + grace + overage
    const runtimeLimitMs = fundedRuntimeMs(fundedMinutes, reservation.multiplier, limitMs)
    if (!runtimeLimitMs) return waitWithoutFunding()
    const state = input.start ? "RUNNING" : "RESERVED"
    await tx.scanCapacityReservation.update({
      where: { scanId: scan.id },
      data: {
        state,
        billingAccountId: billing?.id ?? null,
        cycleStart: balance.cycleStart,
        poolMinutes: pool,
        packMinutes,
        packAllocations: packs,
        graceMinutes: grace,
        overageMinutes: overage,
        fundedMinutes,
        runtimeLimitMs,
      },
    })
    return { state, runtimeLimitMs, fundedMinutes }
  })
}

/** Called inside the meter's account-locked transaction, never starts another transaction. */
export async function settleReservedCapacity(
  tx: ScopedTransaction,
  input: {
    scanId: string
    workspaceId: string
    accountId: string
    ms: number
    idempotencyKey: string
  }
): Promise<{ minutes: number; overageMinutes: number } | null> {
  const reservation = await tx.scanCapacityReservation.findUnique({
    where: { scanId: input.scanId },
  })
  if (!reservation) return null // legacy scan; historical policy remains unchanged
  if (
    reservation.accountId !== input.accountId ||
    reservation.workspaceId !== input.workspaceId ||
    reservation.state !== "RUNNING"
  )
    throw new Error("capacity_settlement_not_running")
  const observedMinutes = Math.ceil(input.ms / 60_000) * reservation.multiplier
  const minutes = Math.min(observedMinutes, reservation.fundedMinutes)
  let remaining = minutes - Math.min(minutes, reservation.poolMinutes)
  const packMinutes = Math.min(remaining, reservation.packMinutes)
  remaining -= packMinutes
  let packDebit = packMinutes
  for (const pack of allocations(reservation.packAllocations)) {
    const debit = Math.min(packDebit, pack.minutes)
    if (!debit) continue
    const changed = await tx.minutePack.updateMany({
      where: {
        id: pack.id,
        accountId: input.accountId,
        deletedAt: null,
        remainingMinutes: { gte: debit },
      },
      data: { remainingMinutes: { decrement: debit } },
    })
    if (changed.count !== 1) throw new Error("reserved_pack_changed")
    packDebit -= debit
  }
  if (packDebit) throw new Error("reserved_pack_receipt_incomplete")
  const overageMinutes = Math.min(remaining, reservation.overageMinutes)
  remaining -= overageMinutes
  const graceMinutes = Math.min(remaining, reservation.graceMinutes)
  if (graceMinutes && reservation.billingAccountId) {
    const billing = await tx.billingAccount.findFirst({
      where: { id: reservation.billingAccountId, accountId: input.accountId },
    })
    if (!billing) throw new Error("reserved_billing_account_missing")
    // A renewal may reset the current-cycle counter while the previous run finishes.
    // Its retained receipt consumes the reserved old cycle, never the new cycle.
    if (
      !billing.graceCycleStart ||
      !reservation.cycleStart ||
      billing.graceCycleStart <= reservation.cycleStart
    ) {
      const changed = await tx.billingAccount.updateMany({
        where: {
          id: billing.id,
          accountId: input.accountId,
          graceUsedMs: { lte: GRACE_CAP_MS - graceMinutes * 60_000 },
        },
        data: {
          graceUsedMs: { increment: graceMinutes * 60_000 },
          graceCycleStart: reservation.cycleStart,
        },
      })
      if (changed.count !== 1) throw new Error("reserved_grace_changed")
    }
  }
  if (overageMinutes)
    await tx.usageRecord.create({
      data: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        kind: "overage_minutes",
        quantity: overageMinutes,
        cycleStart: reservation.cycleStart,
        idempotencyKey: `${input.idempotencyKey}:overage`,
        metadata: {
          scanId: input.scanId,
          accountId: input.accountId,
          accountingVersion: 2,
          rateCentsPerMinute: RATE_CENTS,
          costCents: overageMinutes * RATE_CENTS,
        },
      },
    })
  await tx.usageRecord.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      kind: "agent_minutes",
      quantity: minutes,
      cycleStart: reservation.cycleStart,
      idempotencyKey: input.idempotencyKey,
      metadata: {
        scanId: input.scanId,
        accountId: input.accountId,
        accountingVersion: 2,
        wallClockMs: input.ms,
        rawMinutes: Math.ceil(input.ms / 60_000),
        multiplier: reservation.multiplier,
        poolMinutes: Math.min(minutes, reservation.poolMinutes),
        packMinutes,
        graceMinutes,
        overageMinutes,
        absorbedMinutes: observedMinutes - minutes,
      },
    },
  })
  await tx.scanCapacityReservation.update({
    where: { scanId: input.scanId },
    data: {
      state: "SETTLED",
      observedMs: input.ms,
      chargedMinutes: minutes,
      absorbedMinutes: observedMinutes - minutes,
      settledAt: new Date(),
    },
  })
  return { minutes, overageMinutes }
}

/** Only executor/queue proof of termination may call this. Uncertain money retains the slot. */
export async function confirmScanCapacityStopped(
  workspaceId: string,
  scanId: string,
  noBillableWork = false
): Promise<void> {
  await withWorkspaceRLS(workspaceId, async (tx) => {
    const { scan } = await lockedScan(tx, workspaceId, scanId)
    if (scan.accountingVersion !== 2) return
    const reservation = await tx.scanCapacityReservation.findUnique({ where: { scanId } })
    if (
      !reservation ||
      ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"].includes(scan.status)
    )
      return
    const receipts = await tx.usageRecord.findMany({
      where: {
        accountId: reservation.accountId,
        idempotencyKey: `${workspaceId}:${scanId}:engine_run`,
        kind: "agent_minutes",
      },
    })
    const nonbillable =
      noBillableWork ||
      scan.status === "FAILED" ||
      reservation.state === "WAITING" ||
      reservation.state === "RESERVED"
    const state =
      reservation.state === "SETTLED" && receipts.length === 1
        ? "SETTLED"
        : nonbillable
          ? "RELEASED"
          : "REVIEW_REQUIRED"
    await tx.scanCapacityReservation.update({
      where: { scanId },
      data: { state, stoppedAt: new Date() },
    })
  })
}

/** Deterministic work occupies the initiating-user slot but never reserves money. */
export async function startUnmeteredScanCapacity(
  workspaceId: string,
  scanId: string
): Promise<void> {
  await withWorkspaceRLS(workspaceId, async (tx) => {
    const { scan, accountId } = await lockedScan(tx, workspaceId, scanId)
    if (scan.accountingVersion !== 2) return
    if (!["QUEUED", "PREFLIGHT", "RUNNING"].includes(scan.status))
      throw new Error("capacity_scan_not_executable")
    const plan = scan.executionPlan as { capabilities?: string[] } | null
    if (!plan || plan.capabilities?.includes("engine"))
      throw new Error("unmetered_scan_plan_mismatch")
    const result = await tx.scanCapacityReservation.updateMany({
      where: { scanId, accountId, state: "RESERVED", fundedMinutes: 0 },
      data: { state: "RUNNING" },
    })
    if (result.count !== 1) throw new Error("capacity_execution_already_started")
  })
}

/** The owning worker proves it never entered provider execution before retrying. */
export async function resetUnstartedScanCapacity(
  workspaceId: string,
  scanId: string
): Promise<void> {
  await withWorkspaceRLS(workspaceId, async (tx) => {
    const { scan, accountId } = await lockedScan(tx, workspaceId, scanId)
    if (scan.accountingVersion !== 2 || scan.status !== "QUEUED") return
    const plan = scan.executionPlan as { capabilities?: string[] } | null
    if (!plan) throw new Error("capacity_scan_plan_missing")
    await tx.scanCapacityReservation.updateMany({
      where: { scanId, accountId, state: { in: ["WAITING", "RESERVED", "RUNNING"] } },
      data: {
        state: plan.capabilities?.includes("engine") ? "WAITING" : "RESERVED",
        poolMinutes: 0,
        packMinutes: 0,
        packAllocations: [],
        graceMinutes: 0,
        overageMinutes: 0,
        fundedMinutes: 0,
        runtimeLimitMs: 0,
        cycleStart: null,
        billingAccountId: null,
      },
    })
  })
}
