import { z } from "zod"
/**
 * Closed durable dispatch-authority broker. Unconsumed foundation: no production
 * caller is wired to this module; see
 * docs/design/2026-11-06-durable-dispatch-authority-adr.md.
 *
 * Full broker write set (every path runs through transaction() and the
 * lockOperation() lock set; nothing else is written):
 * - prepare: INSERT ScanDispatchAttempt, INSERT ScanPhysicalExecution, INSERT
 *   ScanDispatchOutbox (PREPARE, sequence 1), UPDATE ScanDispatchOperation
 *   (-> WAITING_CAPACITY | PREPARING). Reads but does not write the
 *   reservation (WAITING stays WAITING).
 * - startPaid: UPDATE Scan (status='RUNNING', startedAt/updatedAt), UPDATE
 *   ScanCapacityReservation (RESERVED -> RUNNING), INSERT ScanEvent
 *   (stage='billable_boundary'), INSERT ScanDispatchStart, INSERT
 *   ScanDispatchOutbox (START_PAID, sequence 2), UPDATE
 *   ScanDispatchOperation (-> START_PENDING).
 * - startUnmetered: mirrors startPaid but requires attempt maxBudgetUsd = 0,
 *   skips the ScanCapacityReservation RUNNING mutation and the billable-boundary
 *   ScanEvent, inserts ScanDispatchStart(kind='UNMETERED', maxBudgetUsd=0,
 *   fundingDigest computed, billableClaimEventId=NULL,
 *   providerGrantDigest=NULL) and ScanDispatchOutbox (START_UNMETERED,
 *   sequence 2), and updates ScanDispatchOperation (-> START_PENDING).
 *   The Scan status='RUNNING' update is kept (retest/deterministic scans
 *   still run), but no capacity or billing side effects occur.
 * - stop: INSERT ScanDispatchOutbox (STOP, sequence 3), UPDATE
 *   ScanDispatchOperation (-> STOPPING).
 * - reconcile: INSERT ScanDispatchOutbox (RECONCILE, sequence 4) only; the
 *   operation stays UNKNOWN until supervisor evidence resolves it.
 * Reads (SELECT ... FOR SHARE / FOR UPDATE): ScanAuthorityEpoch,
 * ScanWorkerInstanceGrant, ScanDispatchOperation, Scan, ScanDispatchAttempt,
 * ScanCapacityReservation, ScanPhysicalExecution, ScanDispatchOutbox,
 * ScanDispatchStart, ScanQueueOutbox, Workspace, Target, Policy, UserScanSlot,
 * ScanEvent, plus EXECUTE on app.scan_dispatch_scope_digest(text),
 * app.scan_target_snapshot_digest(text) and app.scan_policy_digest(text).
 *
 * leasePrismaUnit least-privilege grant list: the identity that leases the
 * connection for this broker (leasePrismaUnit) must hold no more than SELECT
 * on the tables above; INSERT on ScanDispatchAttempt,
 * ScanPhysicalExecution, ScanDispatchOutbox, ScanDispatchStart and ScanEvent;
 * UPDATE on Scan, ScanCapacityReservation and ScanDispatchOperation; EXECUTE
 * on the three app.* digest functions. The publication fence requires
 * UPDATE(updatedAt) on ScanQueueOutbox for PostgreSQL row locking, but no
 * queue-state, payload or publication-receipt write privileges. No INSERT/UPDATE/DELETE on
 * ScanWorkerInstanceGrant, ScanAuthorityEpoch, ScanSupervisorReceipt,
 * ScanPhysicalExecutionTransition or ScanDispatchReleaseReceipt, and no
 * DELETE on any table. The disposable fixture runs as owner/superuser, so
 * production least-privilege is pinned by this comment only; proving it
 * against the real admission identity stays an ADR gate.
 */

import { createId } from "@paralleldrive/cuid2"
import pg from "pg"
import type { ExecutorKey } from "@lyrashield/runtime-control"
import { createPgConnectionConfig } from "./connection-config"
import { createSupervisorReceiptConsumer } from "./scan-supervisor-receipt-ingestion"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"
import {
  bindScanPreparationContext,
  commitPreparationAcknowledgement,
  preparationAcknowledgementDeadlinePassed,
} from "./scan-preparation-authority"
import {
  ScanDispatchAuthorityError,
  prepareDispatch,
  startUnmeteredDispatch,
  valueDigest,
} from "./scan-dispatch-authority-broker-methods"
import { startPaidDispatch } from "./scan-dispatch-authority-broker-start"
import { createScanDispatchLifecycle } from "./scan-dispatch-lifecycle"
import { selectPreparedWorkerStart, type WorkerDispatchInput } from "./scan-dispatch-worker-start"
import type { ScanPreparationCompiler } from "./scan-dispatch-command-descriptor"
import {
  requireScanDispatchWorkerAssignment,
  requireScanDispatchWorkerCleanup,
  requireScanDispatchWorkerStage,
  scanDispatchWorkerRequestOperation,
} from "./scan-dispatch-worker-assignment"

export type DispatchOperationState =
  | "QUEUED"
  | "WAITING_CAPACITY"
  | "PREPARING"
  | "PREPARED"
  | "START_PENDING"
  | "ACTIVE"
  | "STOPPING"
  | "TERMINATED"
  | "REJECTED"
  | "UNKNOWN"

export type DispatchBrokerResult<T extends object = Record<string, never>> =
  | ({ kind: "committed"; operationId: string } & T)
  | {
      kind: "unknown"
      operationId: string
      reasonCode:
        | "COMMIT_OUTCOME_UNKNOWN"
        | "COMMIT_OBSERVED_AFTER_AUTHORITY_DEADLINE"
        | "PREPARATION_ACKNOWLEDGEMENT_DEADLINE"
    }

type TransactionOutcome<T extends object> =
  | { kind: "committed"; operationId: string; value: T }
  | Extract<DispatchBrokerResult, { kind: "unknown" }>

export type PrepareDispatchInput = {
  operationId: string
  workerInstanceId: string
  workerGrantId: string
  authorityEpochId: string
  expiresAt: Date
}

export type PrepareDispatchResult =
  | DispatchBrokerResult<{
      state: "PREPARING"
      attemptId: string
      commandId: string
      authorityAcceptedAt: Date
      authorityDeadlineAt: Date
      eligibility: "CHECKED_INTENT_ONLY"
    }>
  | { kind: "waiting"; operationId: string; state: "WAITING_CAPACITY" }

export type StartPaidDispatchInput = {
  operationId: string
  attemptId: string
  workerInstanceId: string
  workerGrantId: string
  authorityEpochId: string
  executorKey?: ExecutorKey
}

export type StartUnmeteredDispatchInput = StartPaidDispatchInput

export type StartPaidDispatchResult = DispatchBrokerResult<{
  state: "START_PENDING"
  attemptId: string
  startId: string
  commandId: string
}>

export type StartUnmeteredDispatchResult = StartPaidDispatchResult

export type StopDispatchInput = {
  operationId: string
  attemptId: string
  workerInstanceId: string
  workerGrantId: string
  authorityEpochId: string
  reasonCode: string
}

export type StopDispatchResult = DispatchBrokerResult<{
  state: "STOPPING"
  attemptId: string
  commandId: string
}>

export type ReconcileDispatchInput = Omit<StopDispatchInput, "reasonCode">

export type ReconcileDispatchResult = DispatchBrokerResult<{
  state: "UNKNOWN" | "STOPPING"
  attemptId: string
  commandId: string
}>

export type DispatchStatus =
  | {
      kind: "available"
      operationId: string
      state: DispatchOperationState
      attemptId: string | null
      preparationEligibility: "UNAVAILABLE" | "CHECKED_INTENT_ONLY" | "EXPIRED"
    }
  | { kind: "unknown"; operationId: string; reasonCode: "STATUS_UNAVAILABLE" }

export { ScanDispatchAuthorityError }

type BrokerOptions = {
  /** Protected installation only; separate restricted consumer credentials. */
  receiptAuthority?: SupervisorReceiptAuthority
  attemptProofAuthority?: import("./scan-supervisor-receipt-ingestion-verifier").SupervisorAttemptProofAuthority
  consumeReceipts?: (operationId: string) => Promise<unknown>
  connectionString: string
  lifecycleConnectionString?: string
  maximumPoolSize?: number
  /** Internal installation only. This intent contract cannot execute work. */
  preparationAuthority?: "checked-intent-v1"
  compilePreparation?: ScanPreparationCompiler
}

type LockedOperation = {
  operationId: string
  scanId: string
  workspaceId: string
  state: DispatchOperationState
  requestDigest: string
  userId: string
  targetId: string
  sponsorAccountId: string
}

async function runDispatchTransaction<T>(
  pool: pg.Pool,
  operationId: string,
  work: (client: pg.PoolClient) => Promise<T>,
  mode: "normal" | "stage" | "native" = "normal",
  retainedCleanup = false
): Promise<TransactionOutcome<T & object>> {
  const client = await pool.connect()
  let commitAttempted = false
  let discardClient = false
  try {
    if (retainedCleanup && mode !== "native") throw new Error("cleanup requires the native gate")
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE")
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL lock_timeout = '3s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'")
    await client.query("SET LOCAL synchronous_commit = 'remote_apply'")
    await client.query("SET LOCAL timezone = 'UTC'")
    if (mode === "stage") {
      await client.query("SELECT app.require_scan_dispatch_stage_role()")
      await client.query("SELECT pg_advisory_xact_lock_shared(1819234670,1)")
    } else if (mode === "native") {
      await client.query("SELECT app.require_scan_preparation_role()")
      const held = await client.query("SELECT app.acquire_scan_preparation_gate() AS held")
      if (held.rows[0]?.held !== true)
        throw new ScanDispatchAuthorityError(
          "PREPARATION_AUTHORITY_BUSY",
          "Native lifecycle authority is busy"
        )
    }
    await bindScanPreparationContext(client, operationId)
    if (mode === "stage") await requireScanDispatchWorkerStage(client, operationId)
    if (retainedCleanup) await requireScanDispatchWorkerCleanup(client, operationId)
    const value = await work(client)
    if (typeof value !== "object" || value === null)
      throw new Error("dispatch broker transaction returned an invalid value")
    if (mode === "stage") await requireScanDispatchWorkerStage(client, operationId)
    else if (retainedCleanup) await requireScanDispatchWorkerCleanup(client, operationId)
    else await requireScanDispatchWorkerAssignment(client, operationId)
    commitAttempted = true
    if ("authorityDeadlineAt" in value && value.authorityDeadlineAt instanceof Date) {
      const deadline =
        "acknowledgementDeadlineMonotonicMs" in value
          ? Number(value.acknowledgementDeadlineMonotonicMs)
          : NaN
      if (
        !Number.isFinite(deadline) ||
        !(await commitPreparationAcknowledgement(client, value.authorityDeadlineAt, deadline)) ||
        preparationAcknowledgementDeadlinePassed(deadline)
      )
        return { kind: "unknown", operationId, reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE" }
    } else {
      await client.query("COMMIT")
    }
    return { kind: "committed", operationId, value }
  } catch (error) {
    if (!commitAttempted) {
      // A failed ROLLBACK means the socket is unusable (dead backend); the
      // client is released with an error below so pg discards it instead of
      // returning a broken connection to the pool. The original error still
      // surfaces as the transaction result.
      try {
        await client.query("ROLLBACK")
      } catch {
        discardClient = true
      }
      if (error instanceof ScanDispatchAuthorityError) throw error
      throw new ScanDispatchAuthorityError("DATABASE_REJECTED", "Dispatch transaction rejected", {
        cause: error,
      })
    }
    return {
      kind: "unknown",
      operationId,
      reasonCode: "COMMIT_OUTCOME_UNKNOWN",
    }
  } finally {
    client.release(commitAttempted || discardClient)
  }
}

async function lockOperation(
  client: pg.PoolClient,
  input: Pick<PrepareDispatchInput, "operationId" | "authorityEpochId">,
  retainedCleanup = false
): Promise<LockedOperation> {
  const preliminary = await client.query<LockedOperation>(
    `SELECT o."operationId", o."scanId", o."workspaceId", o."state"::text AS state,
            o."requestDigest", s."createdById" AS "userId", s."targetId",
            coalesce(s."sponsorAccountId", s."createdById") AS "sponsorAccountId"
     FROM "ScanDispatchOperation" o
     JOIN "Scan" s ON s."id" = o."scanId"
     WHERE o."operationId" = $1`,
    [input.operationId]
  )
  const pre = preliminary.rows[0]
  if (!pre)
    throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Dispatch operation not found")

  const epoch = await client.query(
    retainedCleanup
      ? 'SELECT 1 FROM "ScanAuthorityEpoch" WHERE "id"=$1 FOR SHARE'
      : 'SELECT 1 FROM "ScanAuthorityEpoch" WHERE "id"=$1 AND "isOpen" FOR SHARE',
    [input.authorityEpochId]
  )
  if (epoch.rowCount !== 1)
    throw new ScanDispatchAuthorityError("AUTHORITY_EPOCH_CLOSED", "Authority epoch is not open")

  // Advisory-key conventions (do not "normalize" blindly; each key is chosen
  // to match the dominant product call sites on the rows this broker writes):
  // - user `scan-user:<id>` and sponsor account `account:<id>` match
  //   scan-slot.ts exactly (hashtextextended, 64-bit).
  // - workspace: raw hashtextextended(workspaceId, 0) matches the dominant
  //   product convention (scan-slot release paths, account-deletion,
  //   target-service create, client reserve, billing capacity/meter/expiry:
  //   8 sites). The prefixed scan-admission:<workspaceId> key
  //   (lockWorkspaceScanAdmission, used by createScan/target-delete) is the
  //   minority key and is deliberately NOT taken; those paths are excluded
  //   by row locks + the post-lock re-read below instead.
  // - target: 32-bit hashtext(targetId) matches the scan-creation/trust
  //   path that touches the same Scan rows (scan-service create,
  //   target-service delete, targets route: 3 sites) over the 64-bit
  //   hashtextextended(targetId) sites (threat-model-service,
  //   ai-system-profile-service: 2 sites), which guard other control planes
  //   and hash a different key value. 32-bit collisions are accepted: row
  //   locks + digest re-read still fail closed (lock_timeout ->
  //   DATABASE_REJECTED).
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `scan-user:${pre.userId}`,
  ])
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [pre.workspaceId])
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pre.targetId])
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `account:${pre.sponsorAccountId}`,
  ])
  await client.query('SELECT 1 FROM "Scan" WHERE "id"=$1 FOR UPDATE', [pre.scanId])
  const operation = await client.query<LockedOperation>(
    `SELECT o."operationId", o."scanId", o."workspaceId", o."state"::text AS state,
            o."requestDigest", s."createdById" AS "userId", s."targetId",
            coalesce(s."sponsorAccountId", s."createdById") AS "sponsorAccountId"
     FROM "ScanDispatchOperation" o
     JOIN "Scan" s ON s."id" = o."scanId"
     WHERE o."operationId" = $1
     FOR UPDATE OF o`,
    [input.operationId]
  )
  const locked = operation.rows[0]
  if (!locked)
    throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Dispatch operation not found")
  if (
    locked.scanId !== pre.scanId ||
    locked.workspaceId !== pre.workspaceId ||
    locked.userId !== pre.userId ||
    locked.targetId !== pre.targetId ||
    locked.sponsorAccountId !== pre.sponsorAccountId
  )
    throw new ScanDispatchAuthorityError(
      "DISPATCH_SCOPE_CHANGED",
      "Dispatch identity changed while locking"
    )
  return locked
}

async function getDispatchStatus(pool: pg.Pool, operationId: string): Promise<DispatchStatus> {
  try {
    const result = await runDispatchTransaction(pool, operationId, async (client) => {
      const result = await client.query<{
        operationId: string
        state: DispatchOperationState
        attemptId: string | null
        preparationEligibility: "UNAVAILABLE" | "CHECKED_INTENT_ONLY" | "EXPIRED"
      }>(
        `SELECT o."operationId", o."state"::text AS state, a."attemptId",
       CASE WHEN a."authorityAcceptedAt" IS NULL THEN 'UNAVAILABLE'
         WHEN a."authorityDeadlineAt"<=clock_timestamp() AT TIME ZONE 'UTC' THEN 'EXPIRED'
         ELSE 'CHECKED_INTENT_ONLY' END AS "preparationEligibility"
       FROM "ScanDispatchOperation" o
       LEFT JOIN "ScanDispatchAttempt" a ON a."operationId" = o."operationId"
       WHERE o."operationId"=$1`,
        [operationId]
      )
      return result.rows[0] ?? { missing: true }
    })
    if (result.kind === "unknown")
      return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
    const row = result.value
    if ("missing" in row) return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
    if (!row) return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
    return { kind: "available", ...row }
  } catch (error) {
    if (
      scanDispatchWorkerRequestOperation() !== undefined &&
      error instanceof ScanDispatchAuthorityError &&
      error.code === "WORKER_GRANT_INVALID"
    )
      throw error
    return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
  }
}

// Outbox `sequence` is a producer-local monotonic hint per attempt
// (1 PREPARE, 2 START_PAID|START_UNMETERED, 3 STOP, 4 RECONCILE); the DB enforces only
// sequence > 0 plus UNIQUE(operationId, commandType). STOP/RECONCILE may be
// inserted without START_PAID ever existing (stop is allowed from
// PREPARING/PREPARED), so dispatch ordering is by commandType presence plus
// the supervisor receipt chain, never by sequence gaps or by a sequence
// value implying a prior command.
async function insertAttemptCommand(
  client: pg.PoolClient,
  input: StopDispatchInput | ReconcileDispatchInput,
  commandType: "STOP" | "RECONCILE",
  sequence: number,
  digestValue: unknown
): Promise<string> {
  const attempt = await client.query<{
    workerInstanceGrantId: string
    authorityEpochId: string
  }>(
    'SELECT "workerInstanceGrantId", "authorityEpochId" FROM "ScanDispatchAttempt" WHERE "operationId"=$1 AND "attemptId"=$2 FOR UPDATE',
    [input.operationId, input.attemptId]
  )
  if (attempt.rowCount !== 1)
    throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Dispatch attempt not found")
  // Bind the command to the caller's worker grant/epoch, mirroring
  // startPaid: a live grant in an open epoch must not STOP/RECONCILE another
  // worker's attempt. Checked before the replay short-circuit below so a
  // mismatched caller fails closed even if the command already exists.
  const attemptRow = attempt.rows[0]!
  if (
    attemptRow.workerInstanceGrantId !== input.workerGrantId ||
    attemptRow.authorityEpochId !== input.authorityEpochId
  )
    throw new ScanDispatchAuthorityError(
      "DISPATCH_REPLAY_CONFLICT",
      "Attempt worker identity changed"
    )
  const existing = await client.query<{ id: string }>(
    `SELECT "id" FROM "ScanDispatchOutbox"
     WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"=$3::"ScanDispatchCommandType"`,
    [input.operationId, input.attemptId, commandType]
  )
  if (existing.rows[0]) return existing.rows[0].id
  const commandId = createId()
  await client.query(
    `INSERT INTO "ScanDispatchOutbox" (
      "id","operationId","attemptId","commandType","sequence","commandDigest","status",
      "attempts","availableAt","createdAt","updatedAt"
    ) VALUES ($1,$2,$3,$4::"ScanDispatchCommandType",$5,$6,'PENDING',0,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      commandId,
      input.operationId,
      input.attemptId,
      commandType,
      sequence,
      valueDigest(`dispatch-command/${commandType}`, digestValue),
    ]
  )
  return commandId
}

async function stopDispatch(pool: pg.Pool, input: StopDispatchInput): Promise<StopDispatchResult> {
  try {
    const outcome = await runDispatchTransaction(pool, input.operationId, async (client) => {
      const operation = await lockOperation(client, input)
      const grant = await client.query(
        `SELECT 1 FROM "ScanWorkerInstanceGrant"
         WHERE "id"=$1 AND "authorityEpochId"=$2 AND "instanceId"=$3
           AND "revokedAt" IS NULL AND "issuedAt" <= CURRENT_TIMESTAMP
           AND "expiresAt" > CURRENT_TIMESTAMP
         FOR SHARE`,
        [input.workerGrantId, input.authorityEpochId, input.workerInstanceId]
      )
      if (grant.rowCount !== 1)
        throw new ScanDispatchAuthorityError(
          "WORKER_GRANT_INVALID",
          "Worker instance grant is not live"
        )
      if (
        !["PREPARING", "PREPARED", "START_PENDING", "ACTIVE", "STOPPING"].includes(operation.state)
      )
        throw new ScanDispatchAuthorityError(
          "DISPATCH_OPERATION_STATE_INVALID",
          `Operation cannot stop from ${operation.state}`
        )
      const commandId = await insertAttemptCommand(client, input, "STOP", 3, {
        operationId: input.operationId,
        attemptId: input.attemptId,
        reasonCode: input.reasonCode,
      })
      if (operation.state !== "STOPPING")
        await client.query(
          'UPDATE "ScanDispatchOperation" SET "state"=\'STOPPING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
          [input.operationId]
        )
      return { state: "STOPPING" as const, attemptId: input.attemptId, commandId }
    })
    if (outcome.kind === "unknown") return outcome
    return { kind: "committed", operationId: input.operationId, ...outcome.value }
  } catch (error) {
    if (error instanceof ScanDispatchAuthorityError) throw error
    throw new ScanDispatchAuthorityError("DATABASE_REJECTED", "Stop transaction rejected", {
      cause: error,
    })
  }
}

async function reconcileDispatch(
  pool: pg.Pool,
  input: ReconcileDispatchInput
): Promise<ReconcileDispatchResult> {
  try {
    const outcome = await runDispatchTransaction(pool, input.operationId, async (client) => {
      const operation = await lockOperation(client, input)
      const grant = await client.query(
        `SELECT 1 FROM "ScanWorkerInstanceGrant"
         WHERE "id"=$1 AND "authorityEpochId"=$2 AND "instanceId"=$3
           AND "revokedAt" IS NULL AND "issuedAt" <= CURRENT_TIMESTAMP
           AND "expiresAt" > CURRENT_TIMESTAMP
         FOR SHARE`,
        [input.workerGrantId, input.authorityEpochId, input.workerInstanceId]
      )
      if (grant.rowCount !== 1)
        throw new ScanDispatchAuthorityError(
          "WORKER_GRANT_INVALID",
          "Worker instance grant is not live"
        )
      if (operation.state !== "UNKNOWN")
        throw new ScanDispatchAuthorityError(
          "DISPATCH_OPERATION_STATE_INVALID",
          "Reconciliation requires an UNKNOWN operation"
        )
      const commandId = await insertAttemptCommand(client, input, "RECONCILE", 4, {
        operationId: input.operationId,
        attemptId: input.attemptId,
        operationState: operation.state,
      })
      return { state: "UNKNOWN" as const, attemptId: input.attemptId, commandId }
    })
    if (outcome.kind === "unknown") return outcome
    return { kind: "committed", operationId: input.operationId, ...outcome.value }
  } catch (error) {
    if (error instanceof ScanDispatchAuthorityError) throw error
    throw new ScanDispatchAuthorityError(
      "DATABASE_REJECTED",
      "Reconciliation transaction rejected",
      {
        cause: error,
      }
    )
  }
}

/** Installed native authority only: authenticate global receipts privately. */
export function createNativeSupervisorReceiptConsumer(authority: SupervisorReceiptAuthority) {
  return createSupervisorReceiptConsumer(authority, lockOperation, (client, input) =>
    lockOperation(client, input, true)
  )
}

export function createScanDispatchAuthorityBroker(options: BrokerOptions) {
  const pool = new pg.Pool({
    ...createPgConnectionConfig(options.connectionString),
    max: options.maximumPoolSize ?? 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  })
  // An intentionally dropped COMMIT response (or a dead backend) terminates the
  // socket of an idle pooled client. pg surfaces that as a pool-level "error"
  // event; without a listener it escapes as an unhandled rejection even though
  // the affected transaction already returned an explicit UNKNOWN result.
  pool.on("error", () => undefined)
  // While a client is checked out, pg raises the dropped socket on the client
  // itself rather than the pool; the failing query still rejects normally, so
  // the event carries no extra information beyond the returned UNKNOWN.
  pool.on("connect", (client) => {
    client.on("error", () => undefined)
  })

  const ctx = {
    preparationAuthority: options.preparationAuthority,
    compilePreparation: options.compilePreparation,
    transaction: <T>(
      operationId: string,
      work: (client: pg.PoolClient) => Promise<T>
    ): Promise<TransactionOutcome<T & object>> => runDispatchTransaction(pool, operationId, work),
    lockOperation,
  }
  const stagePool = options.lifecycleConnectionString
    ? new pg.Pool({
        ...createPgConnectionConfig(options.lifecycleConnectionString),
        max: 2,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 5_000,
      })
    : undefined
  stagePool?.on("error", () => undefined)
  stagePool?.on("connect", (client) => client.on("error", () => undefined))
  const proofAuthority = options.attemptProofAuthority ?? options.receiptAuthority
  const lifecycle = proofAuthority?.readAttemptProof
    ? createScanDispatchLifecycle({
        context: ctx,
        authority: proofAuthority,
        nativeTransaction: <T>(operationId: string, work: (client: pg.PoolClient) => Promise<T>) =>
          runDispatchTransaction(pool, operationId, work, "native"),
        cleanupTransaction: <T>(operationId: string, work: (client: pg.PoolClient) => Promise<T>) =>
          runDispatchTransaction(pool, operationId, work, "native", true),
        cleanupLockOperation: (client, input) => lockOperation(client, input, true),
        stageTransaction: stagePool
          ? <T>(operationId: string, work: (client: pg.PoolClient) => Promise<T>) =>
              runDispatchTransaction(stagePool, operationId, work, "stage")
          : undefined,
      })
    : undefined

  const receiptConsumer = options.receiptAuthority
    ? createSupervisorReceiptConsumer(options.receiptAuthority, lockOperation, (client, input) =>
        lockOperation(client, input, true)
      )
    : undefined

  return {
    async dispatchPrepared(input: WorkerDispatchInput) {
      if (!ctx.preparationAuthority || !lifecycle)
        throw new ScanDispatchAuthorityError(
          "PREPARATION_AUTHORITY_CLOSED",
          "Checked intent execution is closed"
        )
      const selected = await selectPreparedWorkerStart(ctx, input)
      if (selected.kind !== "committed") return selected
      if (!selected.value.input)
        return { kind: "idle" as const, operationId: input.operationId, attemptId: input.attemptId }
      return lifecycle.start(selected.value.input, selected.value.kind)
    },
    consumeSupervisorReceipts: (operationId: unknown) =>
      options.consumeReceipts
        ? options.consumeReceipts(
            z
              .string()
              .min(3)
              .max(192)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
              .parse(operationId)
          )
        : receiptConsumer
          ? receiptConsumer.consume(operationId)
          : Promise.reject(
              new ScanDispatchAuthorityError(
                "SUPERVISOR_CONSUMER_NOT_INSTALLED",
                "Protected supervisor receipt consumer is not installed"
              )
            ),
    prepare: (input: PrepareDispatchInput) => prepareDispatch(ctx, input),
    startPaid: (input: StartPaidDispatchInput) =>
      ctx.preparationAuthority
        ? lifecycle
          ? lifecycle.start(input, "PAID")
          : Promise.reject(
              new ScanDispatchAuthorityError(
                "PREPARATION_AUTHORITY_CLOSED",
                "Checked intent execution is closed"
              )
            )
        : startPaidDispatch(ctx, input),
    startUnmetered: (input: StartUnmeteredDispatchInput) =>
      ctx.preparationAuthority
        ? lifecycle
          ? lifecycle.start(input, "UNMETERED")
          : Promise.reject(
              new ScanDispatchAuthorityError(
                "PREPARATION_AUTHORITY_CLOSED",
                "Checked intent execution is closed"
              )
            )
        : startUnmeteredDispatch(ctx, input),
    stop: (input: StopDispatchInput) =>
      lifecycle ? lifecycle.cleanup(input, "STOP") : stopDispatch(pool, input),
    reconcile: (input: ReconcileDispatchInput) =>
      lifecycle ? lifecycle.cleanup(input, "RECONCILE") : reconcileDispatch(pool, input),
    status: (operationId: string) => getDispatchStatus(pool, operationId),
    async close(): Promise<void> {
      await Promise.all([pool.end(), stagePool?.end(), receiptConsumer?.close()])
    },
  }
}
