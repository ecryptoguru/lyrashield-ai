/**
 * Agent-minute metering — account-owned.
 *
 * Records wall-clock agent minutes consumed during a scan against the
 * sponsoring account (the persisted `Scan.createdById` — browser user, API-key
 * creator, or OAuth connection owner), never "the workspace". The scan's
 * workspaceId remains on the UsageRecord as attribution only.
 *
 * Idempotent via UsageRecord.idempotencyKey = `{workspaceId}:{scanId}:{phase}`.
 *
 * Per D1 constraint: agent-minutes are measured as WALL-CLOCK duration,
 * NOT "active-loop" or "thinking time". The caller passes the elapsed
 * wall-clock milliseconds; this module converts to integer minutes.
 *
 * Deep/Custom scans consume minutes at 3× the standard rate (DEEP_SCAN_MULTIPLIER).
 */

import { bindAccountRLSContext, withWorkspaceRLS, type ScopedTransaction } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { DEEP_SCAN_MULTIPLIER } from "@lyrashield/pricing"
import type { ScanMode } from "@lyrashield/types"
import { resolveAccountBilling } from "../account"
import { resolveBalanceCycleStart } from "./balance"

export interface RecordAgentMinutesOptions {
  /** Scan mode — Deep/Custom applies a 3× multiplier. */
  mode?: ScanMode
  /** Phase label for the idempotency key (e.g. "tick_0", "final"). */
  phase?: string
  /**
   * Allowance-cycle start for this settlement. When omitted it is resolved
   * from the sponsor's current billing state inside the transaction.
   */
  cycleStart?: Date
  /**
   * Terminal outcome of the scan. Founder-confirmed billing rules (2026-08-29):
   * - "failed" scans are NEVER billed — the caller must not call this at all
   *   for a failed terminal state (no agent_minutes UsageRecord is written).
   * - "cancelled" scans bill for the period actually used, WITHOUT the
   *   1-minute floor. A cancel at 20 seconds bills 20 seconds' worth.
   *   Rounding rule (documented): minutes are whole-minute ceiling, so a
   *   cancel at 20s bills 1 minute; the difference vs. a normal scan is that
   *   the floor is not applied, i.e. ms<=0 bills 0 and there is no forced
   *   minimum. Sub-minute (per-second) billing is impractical because
   *   UsageRecord.quantity and all pool/pack arithmetic are integer minutes.
   * - "completed" (default) applies the 1-minute floor as before.
   */
  outcome?: "completed" | "partial" | "failed" | "cancelled"
  /** Resolve uncovered minutes before this transaction commits. Throw to void
   * the entire settlement, including pack and overage writes. Never open a
   * second transaction for the same account from this callback. */
  settleOverage?: (tx: MeterTransaction, minutes: number) => Promise<void>
  /** Finish bounded, idempotent result persistence before monetary commit.
   * A failure rolls back all provisional usage. No provider work belongs here. */
  beforeCommit?: () => Promise<void>
}

export interface RecordAgentMinutesResult {
  /** Whether a new usage record was created (false = idempotent replay). */
  created: boolean
  /** Minutes recorded (after multiplier, 0 on replay). */
  minutes: number
  /** The idempotency key used. */
  idempotencyKey: string
  /** Incremental minutes not covered by the monthly pool or minute packs. */
  overageMinutes: number
  /** The sponsoring account this settlement drew on. */
  accountId: string
}

const MAX_TRANSACTION_ATTEMPTS = 3
type MeterTransaction = ScopedTransaction

/** Read-only recovery check. Never settles or replays interrupted paid work. */
export async function hasUnsettledScanIntent(
  workspaceId: string,
  scanId: string
): Promise<boolean> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scan = await tx.scan.findFirst({
      where: { id: scanId, workspaceId },
      select: {
        createdById: true,
        events: { where: { stage: "billing_settlement_intent" }, select: { metadata: true } },
      },
    })
    const keys = [
      ...new Set(
        (scan?.events ?? []).flatMap(({ metadata }) => {
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return []
          return typeof metadata.idempotencyKey === "string" ? [metadata.idempotencyKey] : []
        })
      ),
    ]
    if (!keys.length) return false
    if (!scan?.createdById) return true
    await bindAccountRLSContext(tx, scan.createdById)
    const receipts = await tx.usageRecord.count({
      where: { workspaceId, kind: "agent_minutes", idempotencyKey: { in: keys } },
    })
    return receipts !== keys.length
  })
}

function isSerializationConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === "P2034"
  )
}

function recordedOverageMinutes(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0
  const value = (metadata as Record<string, unknown>).overageMinutes
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Resolve the sponsoring account for a scan. The persisted createdById is the
 * trusted identity bound at admission — job payloads are untrusted.
 */
async function resolveScanSponsor(tx: MeterTransaction, workspaceId: string, scanId: string) {
  const scan = await tx.scan.findFirst({
    where: { id: scanId, workspaceId },
    select: { createdById: true },
  })
  if (!scan) throw new Error("settlement_scan_not_found")
  return scan.createdById
}

/**
 * Record agent minutes consumed during a scan phase.
 *
 * The caller passes wall-clock milliseconds. This function:
 * 1. Converts ms → integer minutes (ceiling, minimum 1 if ms > 0)
 * 2. Applies the Deep/Custom 3× multiplier
 * 3. Inserts a UsageRecord keyed to the scan's sponsoring account
 * 4. Returns whether a new record was created
 *
 * If the same idempotency key already exists, the call is a no-op (idempotent).
 */
export async function recordAgentMinutes(
  workspaceId: string,
  scanId: string,
  ms: number,
  opts: RecordAgentMinutesOptions = {}
): Promise<RecordAgentMinutesResult> {
  const phase = opts.phase ?? "default"
  const idempotencyKey = `${workspaceId}:${scanId}:${phase}`

  // Failed scans are never billed (founder-confirmed 2026-08-29): refuse to
  // write any agent_minutes UsageRecord regardless of how much work completed.
  if (opts.outcome === "failed") {
    logger.info("Skipping agent-minute billing for failed scan", { workspaceId, scanId })
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0, accountId: "" }
  }

  if (ms <= 0) {
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0, accountId: "" }
  }

  // A-L06: Validate input bounds — reject oversized ms values.
  // A single tick should never represent more than 1 hour of wall-clock time;
  // larger values indicate a bug or abuse attempt.
  const MAX_TICK_MS = 60 * 60 * 1000 // 1 hour
  if (!Number.isFinite(ms) || ms > MAX_TICK_MS) {
    return { created: false, minutes: 0, idempotencyKey, overageMinutes: 0, accountId: "" }
  }

  // Wall-clock ms → integer minutes.
  // - Normal/completed scans: ceiling with a 1-minute floor (min 1 if ms > 0).
  // - Cancelled scans: bill elapsed time only, NO floor (min 0). Rounding rule
  //   is whole-minute ceiling, so a cancel at 20s still rounds to 1 minute;
  //   the floor (which would also give 1) is simply not the mechanism. The
  //   distinction that matters is that a cancelled scan is not forced up to a
  //   minimum — only genuinely elapsed whole minutes are billed.
  const rawMinutes =
    opts.outcome === "cancelled" || opts.outcome === "partial"
      ? Math.ceil(ms / 60_000)
      : Math.max(1, Math.ceil(ms / 60_000))

  // Deep/Custom scans consume 3× minutes
  const isDeep = opts.mode === "DEEP" || opts.mode === "CUSTOM"
  const minutes = isDeep ? rawMinutes * DEEP_SCAN_MULTIPLIER : rawMinutes

  // Resolve the sponsor once (outside the retry loop) under the scan's
  // workspace RLS — the persisted createdById is the trusted identity.
  const sponsorAccountId = await withWorkspaceRLS(workspaceId, (tx) =>
    resolveScanSponsor(tx, workspaceId, scanId)
  )

  // Independent durable intent precedes terminal persistence. UsageRecord is
  // the atomic settlement receipt; missing receipts remain queryable after death.
  if (opts.beforeCommit) {
    await withWorkspaceRLS(workspaceId, async (tx) => {
      const scan = await tx.scan.findFirst({ where: { id: scanId, workspaceId } })
      if (!scan) throw new Error("settlement_scan_not_found")
      await tx.scanEvent.create({
        data: {
          scanId,
          stage: "billing_settlement_intent",
          message: "Settlement intent; missing usage receipt requires terminal accounting review",
          metadata: {
            idempotencyKey,
            workspaceId,
            accountId: sponsorAccountId,
            automaticReplayAllowed: false,
          },
        },
      })
    })
  }

  let finalizationStarted = false
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await withWorkspaceRLS(
        workspaceId,
        async (tx) => {
          // Dual advisory locks, fixed order (workspace then account): the
          // previous image serializes on the workspace lock alone, so a
          // rolled-back binary cannot race this settlement; the account lock
          // serializes same-account settlements across workspaces.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account:${sponsorAccountId}`}, 0))`

          const existing = await tx.usageRecord.findUnique({
            where: { idempotencyKey },
            select: { id: true, metadata: true },
          })
          if (existing) {
            finalizationStarted = Boolean(opts.beforeCommit)
            await opts.beforeCommit?.()
            return {
              created: false,
              minutes: 0,
              idempotencyKey,
              overageMinutes: recordedOverageMinutes(existing.metadata),
              accountId: sponsorAccountId,
            }
          }

          const overageMinutes = await recordMinutesAndDebitIncrementalSpillover(tx, {
            accountId: sponsorAccountId,
            workspaceId,
            scanId,
            minutes,
            idempotencyKey,
            cycleStart: opts.cycleStart,
            mode: opts.mode,
            wallClockMs: ms,
            rawMinutes,
            multiplier: isDeep ? DEEP_SCAN_MULTIPLIER : 1,
          })
          if (overageMinutes > 0) await opts.settleOverage?.(tx, overageMinutes)
          finalizationStarted = Boolean(opts.beforeCommit)
          await opts.beforeCommit?.()

          return {
            created: true,
            minutes,
            idempotencyKey,
            overageMinutes,
            accountId: sponsorAccountId,
          }
        },
        {
          isolationLevel: "Serializable",
          accountId: sponsorAccountId,
          ...(opts.beforeCommit ? { timeout: 30_000 } : {}),
        }
      )
    } catch (error) {
      // Once terminal evidence is durable, never reassess quota or rerun its
      // finalizer in a fresh transaction. An uncertain/aborted monetary commit
      // leaves the successful result intact and uncharged rather than replaying it.
      if (
        isSerializationConflict(error) &&
        !finalizationStarted &&
        attempt < MAX_TRANSACTION_ATTEMPTS
      ) {
        logger.warn("Retrying agent-minute transaction after serialization conflict", {
          workspaceId,
          idempotencyKey,
          attempt,
        })
        continue
      }

      // P2002 remains a safe replay fallback if legacy writers do not take the
      // workspace advisory lock.
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
        logger.debug("Idempotent replay of recordAgentMinutes", { idempotencyKey })
        return {
          created: false,
          minutes: 0,
          idempotencyKey,
          overageMinutes: 0,
          accountId: sponsorAccountId,
        }
      }
      throw error
    }
  }

  throw new Error("agent_minute_transaction_retry_exhausted")
}

/**
 * Record usage and decrement its incremental pack spillover oldest-first.
 *
 * The transaction and advisory locks are owned by recordAgentMinutes. All
 * ledger reads are scoped to the sponsor's accountId (the account's pool,
 * packs, and cycle), never to the scan's workspace. Computing both pre- and
 * post-record spillover prevents each tick from re-debiting the cumulative
 * spillover already reflected in MinutePack.remainingMinutes.
 */
async function recordMinutesAndDebitIncrementalSpillover(
  tx: MeterTransaction,
  input: {
    accountId: string
    workspaceId: string
    scanId: string
    minutes: number
    idempotencyKey: string
    cycleStart?: Date
    mode?: ScanMode
    wallClockMs: number
    rawMinutes: number
    multiplier: number
  }
): Promise<number> {
  const billing = await resolveAccountBilling(input.accountId, tx)
  // The trial anchor lives on User, and trial accounts still carry a
  // provider="trial" marker row — never gate this read on `billing` being
  // absent, or trial consumption misses its pool and reports as overage.
  const trialStartedAt = (
    await tx.user.findUnique({
      where: { id: input.accountId },
      select: { trialStartedAt: true },
    })
  )?.trialStartedAt

  const cycleStart =
    input.cycleStart ??
    resolveBalanceCycleStart({ billing, trialStartedAt: trialStartedAt ?? null })

  const [grantRecords, priorConsumeRecords] = cycleStart
    ? await Promise.all([
        tx.usageRecord.findMany({
          where: {
            accountId: input.accountId,
            kind: { in: ["pool_grant", "trial_grant"] },
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          select: { quantity: true },
        }),
        tx.usageRecord.findMany({
          where: {
            accountId: input.accountId,
            kind: "agent_minutes",
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          select: { quantity: true },
        }),
      ])
    : [[], []]

  const poolMinutes = grantRecords.reduce((sum, record) => sum + record.quantity, 0)
  const priorConsumed = priorConsumeRecords.reduce((sum, record) => sum + record.quantity, 0)
  const priorSpillover = Math.max(0, priorConsumed - poolMinutes)
  const nextSpillover = Math.max(0, priorConsumed + input.minutes - poolMinutes)
  const incrementalSpillover = nextSpillover - priorSpillover

  let toDecrement = incrementalSpillover
  if (toDecrement > 0) {
    const packs = await tx.minutePack.findMany({
      where: {
        accountId: input.accountId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        remainingMinutes: { gt: 0 },
      },
      orderBy: { purchasedAt: "asc" },
      select: { id: true, remainingMinutes: true },
    })

    for (const pack of packs) {
      if (toDecrement <= 0) break
      const decrementAmount = Math.min(pack.remainingMinutes, toDecrement)
      const result = await tx.minutePack.updateMany({
        where: {
          id: pack.id,
          accountId: input.accountId,
          deletedAt: null,
          remainingMinutes: { gte: decrementAmount },
        },
        data: { remainingMinutes: { decrement: decrementAmount } },
      })
      if (result.count !== 1) {
        throw new Error("minute_pack_balance_changed")
      }
      toDecrement -= decrementAmount
    }
  }

  await tx.usageRecord.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      kind: "agent_minutes",
      quantity: input.minutes,
      idempotencyKey: input.idempotencyKey,
      cycleStart: cycleStart ?? null,
      metadata: {
        scanId: input.scanId,
        accountId: input.accountId,
        mode: input.mode ?? null,
        wallClockMs: input.wallClockMs,
        rawMinutes: input.rawMinutes,
        multiplier: input.multiplier,
        overageMinutes: toDecrement,
      },
    },
  })
  return toDecrement
}
