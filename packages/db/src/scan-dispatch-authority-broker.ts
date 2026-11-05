import { createHash } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import pg from "pg"
import { createPgConnectionConfig } from "./connection-config"

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
  | { kind: "unknown"; operationId: string; reasonCode: "COMMIT_OUTCOME_UNKNOWN" }

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
  | DispatchBrokerResult<{ state: "PREPARING"; attemptId: string; commandId: string }>
  | { kind: "waiting"; operationId: string; state: "WAITING_CAPACITY" }

export type StartPaidDispatchInput = {
  operationId: string
  attemptId: string
  workerInstanceId: string
  workerGrantId: string
  authorityEpochId: string
}

export type StartPaidDispatchResult = DispatchBrokerResult<{
  state: "START_PENDING"
  attemptId: string
  startId: string
  commandId: string
}>

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
  state: "UNKNOWN"
  attemptId: string
  commandId: string
}>

export type DispatchStatus =
  | {
      kind: "available"
      operationId: string
      state: DispatchOperationState
      attemptId: string | null
    }
  | { kind: "unknown"; operationId: string; reasonCode: "STATUS_UNAVAILABLE" }

export class ScanDispatchAuthorityError extends Error {
  constructor(
    readonly code:
      | "OPERATION_NOT_FOUND"
      | "AUTHORITY_EPOCH_CLOSED"
      | "WORKER_GRANT_INVALID"
      | "DISPATCH_OPERATION_STATE_INVALID"
      | "DISPATCH_SCOPE_CHANGED"
      | "DISPATCH_REPLAY_CONFLICT"
      | "CAPACITY_NOT_READY"
      | "DATABASE_REJECTED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ScanDispatchAuthorityError"
  }
}

type BrokerOptions = {
  connectionString: string
  maximumPoolSize?: number
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

function commandDigest(commandType: string, operationId: string, attemptId: string): string {
  return createHash("sha256")
    .update(`dispatch-command/1\u0000${commandType}\u0000${operationId}\u0000${attemptId}`)
    .digest("hex")
}

function valueDigest(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\u0000${JSON.stringify(value)}`)
    .digest("hex")
}

function timestampWithoutTimeZone(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "")
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

  async function transaction<T>(
    operationId: string,
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<TransactionOutcome<T & object>> {
    const client = await pool.connect()
    let commitAttempted = false
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE")
      await client.query("SET LOCAL statement_timeout = '15s'")
      await client.query("SET LOCAL lock_timeout = '3s'")
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'")
      await client.query("SET LOCAL synchronous_commit = 'remote_apply'")
      const value = await work(client)
      if (typeof value !== "object" || value === null)
        throw new Error("dispatch broker transaction returned an invalid value")
      commitAttempted = true
      await client.query("COMMIT")
      return { kind: "committed", operationId, value }
    } catch (error) {
      if (!commitAttempted) {
        await client.query("ROLLBACK").catch(() => undefined)
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
      client.release(commitAttempted)
    }
  }

  async function lockOperation(
    client: pg.PoolClient,
    input: Pick<PrepareDispatchInput, "operationId" | "authorityEpochId">
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
      'SELECT 1 FROM "ScanAuthorityEpoch" WHERE "id"=$1 AND "isOpen" FOR SHARE',
      [input.authorityEpochId]
    )
    if (epoch.rowCount !== 1)
      throw new ScanDispatchAuthorityError("AUTHORITY_EPOCH_CLOSED", "Authority epoch is not open")

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `scan-user:${pre.userId}`,
    ])
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `scan-admission:${pre.workspaceId}`,
    ])
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

  async function prepare(input: PrepareDispatchInput): Promise<PrepareDispatchResult> {
    try {
      const expiresAt = timestampWithoutTimeZone(input.expiresAt)
      const outcome = await transaction(input.operationId, async (client) => {
        const operation = await lockOperation(client, input)
        const grant = await client.query(
          `SELECT 1 FROM "ScanWorkerInstanceGrant"
           WHERE "id"=$1 AND "authorityEpochId"=$2 AND "instanceId"=$3
             AND "revokedAt" IS NULL AND "issuedAt" <= CURRENT_TIMESTAMP
             AND "expiresAt" > CURRENT_TIMESTAMP AND "expiresAt" >= $4::timestamp
           FOR SHARE`,
          [input.workerGrantId, input.authorityEpochId, input.workerInstanceId, expiresAt]
        )
        if (grant.rowCount !== 1)
          throw new ScanDispatchAuthorityError(
            "WORKER_GRANT_INVALID",
            "Worker instance grant is not live"
          )

        const existing = await client.query<{
          attemptId: string
          commandId: string
          workerInstanceId: string
          workerInstanceGrantId: string
          authorityEpochId: string
        }>(
          `SELECT a."attemptId", o."id" AS "commandId", g."instanceId" AS "workerInstanceId",
                  a."workerInstanceGrantId", a."authorityEpochId"
           FROM "ScanDispatchAttempt" a
           JOIN "ScanDispatchOutbox" o ON o."operationId" = a."operationId" AND o."commandType"='PREPARE'
           JOIN "ScanWorkerInstanceGrant" g ON g."id" = a."workerInstanceGrantId"
           WHERE a."operationId"=$1`,
          [input.operationId]
        )
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (
            row.workerInstanceId !== input.workerInstanceId ||
            row.workerInstanceGrantId !== input.workerGrantId ||
            row.authorityEpochId !== input.authorityEpochId
          )
            throw new ScanDispatchAuthorityError(
              "DISPATCH_REPLAY_CONFLICT",
              "Preparation replay changed worker authority"
            )
          return { state: "PREPARING" as const, attemptId: row.attemptId, commandId: row.commandId }
        }
        if (!["QUEUED", "WAITING_CAPACITY"].includes(operation.state))
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            `Operation ${operation.operationId} cannot prepare from ${operation.state}`
          )

        const reservation = await client.query<{ state: string }>(
          'SELECT "state" FROM "ScanCapacityReservation" WHERE "scanId"=$1 FOR UPDATE',
          [operation.scanId]
        )
        if (reservation.rows[0]?.state === "WAITING") {
          await client.query(
            'UPDATE "ScanDispatchOperation" SET "state"=\'WAITING_CAPACITY\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
            [operation.operationId]
          )
          return { waiting: true as const }
        }
        if (reservation.rows[0]?.state !== "RESERVED")
          throw new ScanDispatchAuthorityError("CAPACITY_NOT_READY", "Capacity is not reserved")

        const digests = await client.query<{
          scopeDigest: string
          targetDigest: string
          policyDigest: string
        }>(
          `SELECT app.scan_dispatch_scope_digest($1) AS "scopeDigest",
                  app.scan_target_snapshot_digest($2) AS "targetDigest",
                  app.scan_policy_digest((SELECT "policyId" FROM "Scan" WHERE "id"=$1)) AS "policyDigest"`,
          [operation.scanId, operation.targetId]
        )
        const digest = digests.rows[0]!
        if (digest.scopeDigest !== operation.requestDigest)
          throw new ScanDispatchAuthorityError("DISPATCH_SCOPE_CHANGED", "Admitted scope changed")

        const scan = await client.query<{
          executionPlanHash: string
          policyId: string | null
          delegatedAuthorizationVersion: number | null
          attachmentIds: string[]
          mode: string
          goal: string
          maxBudgetUsd: string
          maxRuntimeMs: number
        }>(
          `SELECT "executionPlanHash", "policyId", "delegatedAuthorizationVersion",
                  coalesce("executionPlan"->'attachmentIds', '[]'::jsonb) AS "attachmentIds",
                  "mode"::text AS mode, "goal"::text AS goal,
                  ("executionPlan" #>> '{limits,maxBudgetUsd}') AS "maxBudgetUsd",
                  ("executionPlan" #>> '{limits,maxDurationMs}')::integer AS "maxRuntimeMs"
           FROM "Scan" WHERE "id"=$1`,
          [operation.scanId]
        )
        const scanRow = scan.rows[0]
        if (!scanRow) throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Scan not found")
        const attemptId = createId()
        const commandId = createId()
        await client.query(
          `INSERT INTO "ScanDispatchAttempt" (
            "operationId","attemptId","scanId","workspaceId","initiatingUserId","sponsorAccountId",
            "targetId","targetSnapshotDigest","executionPlanHash","scopeDigest","policyId",
            "policyVersion","policyDigest","delegatedAuthorizationVersion","attachmentIds","focusDigest",
            "mode","goal","maxBudgetUsd","maxRuntimeMs","authorityEpochId","workerInstanceGrantId","expiresAt"
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dispatch-v1',$12,$13,$14::text[],NULL,
            $15::"ScanMode",$16::"ScanGoal",$17::numeric,$18,$19,$20,$21::timestamp
          )`,
          [
            operation.operationId,
            attemptId,
            operation.scanId,
            operation.workspaceId,
            operation.userId,
            operation.sponsorAccountId,
            operation.targetId,
            digest.targetDigest,
            scanRow.executionPlanHash,
            digest.scopeDigest,
            scanRow.policyId,
            digest.policyDigest,
            scanRow.delegatedAuthorizationVersion,
            scanRow.attachmentIds,
            scanRow.mode,
            scanRow.goal,
            scanRow.maxBudgetUsd,
            scanRow.maxRuntimeMs,
            input.authorityEpochId,
            input.workerGrantId,
            expiresAt,
          ]
        )
        await client.query(
          `INSERT INTO "ScanPhysicalExecution" (
            "attemptId","operationId","scanId","workspaceId","authorityEpochId","workerInstanceGrantId",
            "state","unresolvedKey","revision","createdAt","updatedAt"
          ) VALUES ($1,$2,$3,$4,$5,$6,'RESERVED',$3,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [
            attemptId,
            operation.operationId,
            operation.scanId,
            operation.workspaceId,
            input.authorityEpochId,
            input.workerGrantId,
          ]
        )
        await client.query(
          `INSERT INTO "ScanDispatchOutbox" (
            "id","operationId","attemptId","commandType","sequence","commandDigest","status",
            "attempts","availableAt","createdAt","updatedAt"
          ) VALUES ($1,$2,$3,'PREPARE',1,$4,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [
            commandId,
            operation.operationId,
            attemptId,
            commandDigest("PREPARE", operation.operationId, attemptId),
          ]
        )
        await client.query(
          'UPDATE "ScanDispatchOperation" SET "state"=\'PREPARING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
          [operation.operationId]
        )
        return { waiting: false as const, state: "PREPARING" as const, attemptId, commandId }
      })
      if (outcome.kind === "unknown") return outcome
      if (outcome.value.waiting)
        return { kind: "waiting", operationId: input.operationId, state: "WAITING_CAPACITY" }
      return {
        kind: "committed",
        operationId: input.operationId,
        state: outcome.value.state,
        attemptId: outcome.value.attemptId,
        commandId: outcome.value.commandId,
      }
    } catch (error) {
      if (error instanceof ScanDispatchAuthorityError) throw error
      throw new ScanDispatchAuthorityError(
        "DATABASE_REJECTED",
        "Preparation transaction rejected",
        {
          cause: error,
        }
      )
    }
  }

  async function status(operationId: string): Promise<DispatchStatus> {
    try {
      const result = await pool.query<{
        operationId: string
        state: DispatchOperationState
        attemptId: string | null
      }>(
        `SELECT o."operationId", o."state"::text AS state, a."attemptId"
         FROM "ScanDispatchOperation" o
         LEFT JOIN "ScanDispatchAttempt" a ON a."operationId" = o."operationId"
         WHERE o."operationId"=$1`,
        [operationId]
      )
      const row = result.rows[0]
      if (!row) return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
      return { kind: "available", ...row }
    } catch {
      return { kind: "unknown", operationId, reasonCode: "STATUS_UNAVAILABLE" }
    }
  }

  async function startPaid(input: StartPaidDispatchInput): Promise<StartPaidDispatchResult> {
    try {
      const outcome = await transaction(input.operationId, async (client) => {
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

        const attempt = await client.query<{
          attemptId: string
          scanId: string
          operationId: string
          maxBudgetUsd: string
          maxRuntimeMs: number
          policyDigest: string
          workerInstanceGrantId: string
          authorityEpochId: string
          scanStatus: string
        }>(
          `SELECT a."attemptId", a."scanId", a."operationId", a."maxBudgetUsd"::text AS "maxBudgetUsd",
                  a."maxRuntimeMs", a."policyDigest", a."workerInstanceGrantId", a."authorityEpochId",
                  s."status"::text AS "scanStatus"
           FROM "ScanDispatchAttempt" a
           JOIN "Scan" s ON s."id" = a."scanId"
           WHERE a."operationId"=$1 AND a."attemptId"=$2
           FOR UPDATE OF a, s`,
          [input.operationId, input.attemptId]
        )
        const attemptRow = attempt.rows[0]
        if (!attemptRow)
          throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Dispatch attempt not found")
        if (
          attemptRow.workerInstanceGrantId !== input.workerGrantId ||
          attemptRow.authorityEpochId !== input.authorityEpochId
        )
          throw new ScanDispatchAuthorityError(
            "DISPATCH_REPLAY_CONFLICT",
            "Attempt worker identity changed"
          )

        const existing = await client.query<{ startId: string; commandId: string }>(
          `SELECT st."startId", o."id" AS "commandId"
           FROM "ScanDispatchStart" st
           JOIN "ScanDispatchOutbox" o ON o."operationId"=st."operationId"
             AND o."attemptId"=st."attemptId" AND o."commandType"='START_PAID'
           WHERE st."operationId"=$1 AND st."attemptId"=$2`,
          [input.operationId, input.attemptId]
        )
        if (existing.rows[0])
          return {
            state: "START_PENDING" as const,
            attemptId: input.attemptId,
            startId: existing.rows[0].startId,
            commandId: existing.rows[0].commandId,
          }

        if (operation.state !== "PREPARED")
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            `Paid start requires PREPARED, found ${operation.state}`
          )
        const physical = await client.query<{ state: string }>(
          'SELECT "state"::text AS state FROM "ScanPhysicalExecution" WHERE "attemptId"=$1 FOR UPDATE',
          [input.attemptId]
        )
        if (physical.rows[0]?.state !== "PREPARING")
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            "Physical preparation is incomplete"
          )
        const preparation = await client.query<{ status: string }>(
          `SELECT "status"::text AS status FROM "ScanDispatchOutbox"
           WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"='PREPARE' FOR UPDATE`,
          [input.operationId, input.attemptId]
        )
        if (preparation.rows[0]?.status !== "COMPLETED")
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            "PREPARE is not complete"
          )
        const reservation = await client.query<{
          accountId: string
          state: string
          fundedMinutes: number
          runtimeLimitMs: number
          poolMinutes: number
          packMinutes: number
          graceMinutes: number
          overageMinutes: number
        }>(
          `SELECT "accountId", "state", "fundedMinutes", "runtimeLimitMs", "poolMinutes",
                  "packMinutes", "graceMinutes", "overageMinutes"
           FROM "ScanCapacityReservation" WHERE "scanId"=$1 FOR UPDATE`,
          [attemptRow.scanId]
        )
        const funding = reservation.rows[0]
        if (!funding || funding.state !== "RESERVED" || funding.fundedMinutes <= 0)
          throw new ScanDispatchAuthorityError(
            "CAPACITY_NOT_READY",
            "Funded reservation is not ready"
          )
        if (!["QUEUED", "PREFLIGHT"].includes(attemptRow.scanStatus))
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            "Scan is not startable"
          )

        const maxBudgetUsd = Number(attemptRow.maxBudgetUsd)
        if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)
          throw new ScanDispatchAuthorityError(
            "CAPACITY_NOT_READY",
            "Paid start requires a positive budget"
          )
        const maxRuntimeMs = Math.min(attemptRow.maxRuntimeMs, funding.runtimeLimitMs)
        if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs <= 0)
          throw new ScanDispatchAuthorityError(
            "CAPACITY_NOT_READY",
            "Paid start requires runtime capacity"
          )
        const startId = createId()
        const billableClaimEventId = createId()
        const commandId = createId()
        const fundingDigest = valueDigest("dispatch-funding/1", {
          scanId: attemptRow.scanId,
          accountId: funding.accountId,
          fundedMinutes: funding.fundedMinutes,
          poolMinutes: funding.poolMinutes,
          packMinutes: funding.packMinutes,
          graceMinutes: funding.graceMinutes,
          overageMinutes: funding.overageMinutes,
          runtimeLimitMs: funding.runtimeLimitMs,
          maxRuntimeMs,
        })
        const providerGrantDigest = valueDigest("provider-grant-intent/1", {
          attemptId: attemptRow.attemptId,
          startId,
          maxBudgetUsd,
          maxRuntimeMs,
        })

        await client.query(
          'UPDATE "Scan" SET "status"=\'RUNNING\', "startedAt"=coalesce("startedAt",CURRENT_TIMESTAMP), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
          [attemptRow.scanId]
        )
        await client.query(
          'UPDATE "ScanCapacityReservation" SET "state"=\'RUNNING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "scanId"=$1',
          [attemptRow.scanId]
        )
        await client.query(
          `INSERT INTO "ScanEvent" ("id","scanId","stage","level","message","metadata","createdAt")
           VALUES ($1,$2,'billable_boundary','info',
             'Automatic retries disabled before provider-billable analysis', $3::jsonb, CURRENT_TIMESTAMP)`,
          [
            billableClaimEventId,
            attemptRow.scanId,
            JSON.stringify({ retryPolicy: "fresh_scan_required" }),
          ]
        )
        await client.query(
          `INSERT INTO "ScanDispatchStart" (
            "startId","operationId","attemptId","kind","maxBudgetUsd","maxRuntimeMs",
            "policyDigest","fundingDigest","billableClaimEventId","providerGrantDigest","createdAt"
          ) VALUES ($1,$2,$3,'PAID',$4::numeric,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)`,
          [
            startId,
            input.operationId,
            input.attemptId,
            maxBudgetUsd,
            maxRuntimeMs,
            attemptRow.policyDigest,
            fundingDigest,
            billableClaimEventId,
            providerGrantDigest,
          ]
        )
        await client.query(
          `INSERT INTO "ScanDispatchOutbox" (
            "id","operationId","attemptId","commandType","sequence","commandDigest","status",
            "attempts","availableAt","createdAt","updatedAt"
          ) VALUES ($1,$2,$3,'START_PAID',2,$4,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [
            commandId,
            input.operationId,
            input.attemptId,
            commandDigest("START_PAID", input.operationId, input.attemptId),
          ]
        )
        await client.query(
          'UPDATE "ScanDispatchOperation" SET "state"=\'START_PENDING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
          [input.operationId]
        )
        return { state: "START_PENDING" as const, attemptId: input.attemptId, startId, commandId }
      })
      if (outcome.kind === "unknown") return outcome
      return { kind: "committed", operationId: input.operationId, ...outcome.value }
    } catch (error) {
      if (error instanceof ScanDispatchAuthorityError) throw error
      throw new ScanDispatchAuthorityError("DATABASE_REJECTED", "Paid-start transaction rejected", {
        cause: error,
      })
    }
  }

  async function insertAttemptCommand(
    client: pg.PoolClient,
    input: StopDispatchInput | ReconcileDispatchInput,
    commandType: "STOP" | "RECONCILE",
    sequence: number,
    digestValue: unknown
  ): Promise<string> {
    const attempt = await client.query(
      'SELECT 1 FROM "ScanDispatchAttempt" WHERE "operationId"=$1 AND "attemptId"=$2 FOR UPDATE',
      [input.operationId, input.attemptId]
    )
    if (attempt.rowCount !== 1)
      throw new ScanDispatchAuthorityError("OPERATION_NOT_FOUND", "Dispatch attempt not found")
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

  async function stop(input: StopDispatchInput): Promise<StopDispatchResult> {
    try {
      const outcome = await transaction(input.operationId, async (client) => {
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
          !["PREPARING", "PREPARED", "START_PENDING", "ACTIVE", "STOPPING"].includes(
            operation.state
          )
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

  async function reconcile(input: ReconcileDispatchInput): Promise<ReconcileDispatchResult> {
    try {
      const outcome = await transaction(input.operationId, async (client) => {
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

  return {
    prepare,
    startPaid,
    stop,
    reconcile,
    status,
    async close(): Promise<void> {
      await pool.end()
    },
  }
}
