import type pg from "pg"
import type { PrepareDispatchInput } from "./scan-dispatch-authority-broker"
import { resolveScanProfile } from "@lyrashield/types"
import { verifyStoredScanExecutionPlan } from "./scan-execution-plan"
import type { LockedOperation } from "./scan-dispatch-authority-broker-methods"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

export type CheckedPreparationAuthority = {
  authorityAcceptedAt: Date
  authorityDeadlineAt: Date
  databaseClockUpperBoundMs: number
  monotonicClockMs: number
}

/** Persisted private context only; caller-supplied payer/workspace is never accepted. */
export async function bindScanPreparationContext(client: pg.PoolClient, operationId: string) {
  const row = (
    await client.query<{ workspaceId: string; accountId: string; userId: string }>(
      "SELECT * FROM app.scan_preparation_context($1)",
      [operationId]
    )
  ).rows[0]
  if (!row)
    throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Operation context unavailable")
  await client.query(
    "SELECT set_config('app.current_workspace_id',$1,true),set_config('app.current_account_id',$2,true),set_config('app.current_scan_user_id',$3,true)",
    [row.workspaceId, row.accountId, row.userId]
  )
}

/** Separate READ COMMITTED statements are part of the authority contract. */
export async function checkPreparationAuthority(
  client: pg.PoolClient,
  operation: LockedOperation,
  expiresAt: string
): Promise<CheckedPreparationAuthority> {
  const acquired = await client.query<{ acquired: boolean }>(
    "SELECT app.acquire_scan_preparation_gate() AS acquired"
  )
  if (!acquired.rows[0]?.acquired)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_BUSY",
      "Preparation authority is changing"
    )
  const monotonicClockMs = performance.now()
  const checked = await client.query<{ acceptedAt: Date; deadlineAt: Date }>(
    'SELECT "acceptedAt" AT TIME ZONE \'UTC\' AS "acceptedAt","deadlineAt" AT TIME ZONE \'UTC\' AS "deadlineAt" FROM app.check_scan_preparation_authority($1,$2::timestamp)',
    [operation.scanId, expiresAt]
  )
  const row = checked.rows[0]
  if (!row)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Preparation authority unavailable"
    )
  const stored = (
    await client.query<{ executionPlan: unknown; executionPlanHash: string; targetType: string }>(
      `SELECT s."executionPlan",s."executionPlanHash",t.type::text AS "targetType"
       FROM "Scan" s JOIN "Target" t ON t.id=s."targetId" AND t."workspaceId"=s."workspaceId"
       WHERE s.id=$1 AND s."workspaceId"=$2`,
      [operation.scanId, operation.workspaceId]
    )
  ).rows[0]
  const plan = verifyStoredScanExecutionPlan(stored?.executionPlan, stored?.executionPlanHash)
  if (!stored || !plan.ok)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Stored plan unavailable"
    )
  const profile = resolveScanProfile({ targetType: stored.targetType, mode: plan.plan.depth })
  if (
    stored.targetType !== "REPO" ||
    plan.plan.targetType !== "REPO" ||
    plan.plan.profileId !== profile.id ||
    plan.plan.limits.maxBudgetUsd > profile.maxBudgetUsd ||
    plan.plan.limits.maxDurationMs > profile.maxDurationMinutes * 60_000 ||
    plan.plan.limits.maxEngineMs > profile.maxEngineMinutes * 60_000 ||
    plan.plan.limits.scannerReserveMs > profile.scannerReserveMinutes * 60_000
  )
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Current profile does not cover stored plan"
    )
  return {
    authorityAcceptedAt: row.acceptedAt,
    authorityDeadlineAt: row.deadlineAt,
    // SQL floors milliseconds. An upper bound never extends the DB deadline.
    databaseClockUpperBoundMs: row.acceptedAt.getTime() + 1,
    monotonicClockMs,
  }
}

/** A positive transport acknowledgement after the DB deadline is still UNKNOWN. */
export async function preparationAcknowledgementIsLive(client: pg.PoolClient, deadline: Date) {
  const row = (
    await client.query<{ live: boolean }>(
      "SELECT clock_timestamp() AT TIME ZONE 'UTC' < $1::timestamp AS live",
      [deadline.toISOString().replace("T", " ").replace("Z", "")]
    )
  ).rows[0]
  return row?.live === true
}

export async function readPrepareReplay(
  client: pg.PoolClient,
  input: PrepareDispatchInput
): Promise<{
  attemptId: string
  commandId: string
  workerInstanceId: string
  workerInstanceGrantId: string
  authorityEpochId: string
  authorityAcceptedAt: Date
  authorityDeadlineAt: Date
} | null> {
  const existing = await client.query<{
    attemptId: string
    commandId: string
    workerInstanceId: string
    workerInstanceGrantId: string
    authorityEpochId: string
    authorityAcceptedAt: Date | null
    authorityDeadlineAt: Date | null
    authorityTransactionId: string | null
    expiresAt: Date
  }>(
    `SELECT a."attemptId", o."id" AS "commandId", g."instanceId" AS "workerInstanceId",
            a."workerInstanceGrantId", a."authorityEpochId",a."authorityAcceptedAt" AT TIME ZONE 'UTC' AS "authorityAcceptedAt",
            a."authorityDeadlineAt" AT TIME ZONE 'UTC' AS "authorityDeadlineAt",a."authorityTransactionId",a."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt"
     FROM "ScanDispatchAttempt" a
     JOIN "ScanDispatchOutbox" o ON o."operationId" = a."operationId" AND o."commandType"='PREPARE'
     JOIN "ScanWorkerInstanceGrant" g ON g."id" = a."workerInstanceGrantId"
     WHERE a."operationId"=$1`,
    [input.operationId]
  )
  const row = existing.rows[0]
  if (!row) return null
  const live = await client.query<{ live: boolean }>(
    "SELECT clock_timestamp() AT TIME ZONE 'UTC' < $1::timestamp AS live",
    [
      row.authorityDeadlineAt
        ? row.authorityDeadlineAt.toISOString().replace("T", " ").replace("Z", "")
        : null,
    ]
  )
  if (
    !row.authorityAcceptedAt ||
    !row.authorityDeadlineAt ||
    !row.authorityTransactionId ||
    !/^\d+$/.test(row.authorityTransactionId) ||
    !Number.isFinite(row.authorityAcceptedAt.getTime()) ||
    !Number.isFinite(row.authorityDeadlineAt.getTime()) ||
    row.authorityDeadlineAt.getTime() <= row.authorityAcceptedAt.getTime() ||
    row.authorityDeadlineAt.getTime() > row.authorityAcceptedAt.getTime() + 10_000 ||
    row.authorityDeadlineAt.getTime() > row.expiresAt.getTime() ||
    !live.rows[0]?.live
  )
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_UNAVAILABLE",
      "Original preparation deadline unavailable or expired"
    )
  if (
    row.workerInstanceId !== input.workerInstanceId ||
    row.workerInstanceGrantId !== input.workerGrantId ||
    row.authorityEpochId !== input.authorityEpochId ||
    row.expiresAt.getTime() !== input.expiresAt.getTime()
  )
    throw new ScanDispatchAuthorityError(
      "DISPATCH_REPLAY_CONFLICT",
      "Preparation replay changed worker authority"
    )
  return {
    ...row,
    authorityAcceptedAt: row.authorityAcceptedAt,
    authorityDeadlineAt: row.authorityDeadlineAt,
  }
}

/** Internal monotonic clock mapping; never a public or physical capability. */
export function withPreparationAcknowledgementDeadline<T extends { authorityDeadlineAt: Date }>(
  value: T,
  authority: CheckedPreparationAuthority
) {
  return {
    ...value,
    acknowledgementDeadlineMonotonicMs:
      authority.monotonicClockMs +
      value.authorityDeadlineAt.getTime() -
      authority.databaseClockUpperBoundMs,
  }
}

export function preparationAcknowledgementDeadlinePassed(deadline: number) {
  return !Number.isFinite(deadline) || performance.now() >= deadline
}

/** Bound COMMIT and its readback together, including withheld network responses. */
export async function commitPreparationAcknowledgement(
  client: pg.PoolClient,
  deadlineAt: Date,
  monotonicDeadline: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, monotonicDeadline - performance.now()))
  })
  const acknowledgement = (async () => {
    await client.query("COMMIT")
    return await preparationAcknowledgementIsLive(client, deadlineAt)
  })()
  try {
    const live = await Promise.race([acknowledgement, expired])
    return live && !preparationAcknowledgementDeadlinePassed(monotonicDeadline)
  } finally {
    clearTimeout(timer)
  }
}
