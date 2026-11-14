import { createHash } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import {
  checkPreparationAuthority,
  readPrepareReplay,
  withPreparationAcknowledgementDeadline,
  preparationAcknowledgementDeadlinePassed,
} from "./scan-preparation-authority"
import { requirePublishedScanQueueAuthority } from "./scan-queue-outbox-store"
import { ScanQueueOutboxError, scanQueueDigest } from "./scan-queue-payload"
import {
  compilePreparationCommand,
  type ScanPreparationCompiler,
} from "./scan-dispatch-command-descriptor"
import type {
  DispatchBrokerResult,
  DispatchOperationState,
  PrepareDispatchInput,
  PrepareDispatchResult,
  StartUnmeteredDispatchInput,
  StartUnmeteredDispatchResult,
} from "./scan-dispatch-authority-broker"

export { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"

export type LockedOperation = {
  operationId: string
  scanId: string
  workspaceId: string
  state: DispatchOperationState
  requestDigest: string
  userId: string
  targetId: string
  sponsorAccountId: string
}

type TransactionOutcome<T extends object> =
  | { kind: "committed"; operationId: string; value: T }
  | Extract<DispatchBrokerResult, { kind: "unknown" }>

export type DispatchBrokerContext = {
  preparationAuthority?: "checked-intent-v1"
  compilePreparation?: ScanPreparationCompiler
  transaction: <T>(
    operationId: string,
    work: (client: pg.PoolClient) => Promise<T>
  ) => Promise<TransactionOutcome<T & object>>
  lockOperation: (
    client: pg.PoolClient,
    input: Pick<PrepareDispatchInput, "operationId" | "authorityEpochId">
  ) => Promise<LockedOperation>
}

export function commandDigest(commandType: string, operationId: string, attemptId: string): string {
  return createHash("sha256")
    .update(`dispatch-command/1\u0000${commandType}\u0000${operationId}\u0000${attemptId}`)
    .digest("hex")
}

export function valueDigest(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\u0000${JSON.stringify(value)}`)
    .digest("hex")
}

function timestampWithoutTimeZone(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "")
}

async function checkPrepareGrant(
  client: pg.PoolClient,
  input: PrepareDispatchInput,
  expiresAt: string
): Promise<void> {
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
}

async function checkPrepareCapacity(
  client: pg.PoolClient,
  operation: LockedOperation
): Promise<boolean> {
  const reservation = await client.query<{ state: string }>(
    'SELECT "state" FROM "ScanCapacityReservation" WHERE "scanId"=$1 FOR UPDATE',
    [operation.scanId]
  )
  if (reservation.rows[0]?.state === "WAITING") {
    await client.query(
      'UPDATE "ScanDispatchOperation" SET "state"=\'WAITING_CAPACITY\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
      [operation.operationId]
    )
    return true
  }
  if (reservation.rows[0]?.state !== "RESERVED")
    throw new ScanDispatchAuthorityError("CAPACITY_NOT_READY", "Capacity is not reserved")
  return false
}

async function loadPrepareScope(
  client: pg.PoolClient,
  operation: LockedOperation
): Promise<{
  digest: {
    scopeDigest: string
    targetDigest: string
    policyDigest: string
  }
  scanRow: {
    executionPlanHash: string
    policyId: string | null
    delegatedAuthorizationVersion: number | null
    attachmentIds: string[]
    mode: string
    goal: string
    maxBudgetUsd: string
    maxRuntimeMs: number
  }
}> {
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
  return { digest, scanRow }
}

async function createPrepareAttempt(
  client: pg.PoolClient,
  operation: LockedOperation,
  digest: {
    scopeDigest: string
    targetDigest: string
    policyDigest: string
  },
  scanRow: {
    executionPlanHash: string
    policyId: string | null
    delegatedAuthorizationVersion: number | null
    attachmentIds: string[]
    mode: string
    goal: string
    maxBudgetUsd: string
    maxRuntimeMs: number
  },
  input: PrepareDispatchInput,
  expiresAt: string,
  focusDigest: string | null,
  compilePreparation: ScanPreparationCompiler,
  focus: import("@lyrashield/types").ScanJobData["focus"]
): Promise<{
  waiting: false
  state: "PREPARING"
  attemptId: string
  commandId: string
  authorityAcceptedAt: Date
  authorityDeadlineAt: Date
}> {
  const attemptId = createId()
  const commandId = createId()
  await client.query(
    `INSERT INTO "ScanDispatchAttempt" (
      "operationId","attemptId","scanId","workspaceId","initiatingUserId","sponsorAccountId",
      "targetId","targetSnapshotDigest","executionPlanHash","scopeDigest","policyId",
      "policyVersion","policyDigest","delegatedAuthorizationVersion","attachmentIds","focusDigest",
      "mode","goal","maxBudgetUsd","maxRuntimeMs","authorityEpochId","workerInstanceGrantId","expiresAt"
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dispatch-v1',$12,$13,$14::text[],$22,
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
      focusDigest,
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
  const descriptor = await compilePreparationCommand(
    client,
    { commandId, attemptId, operationId: operation.operationId },
    compilePreparation,
    focus
  )
  await client.query(
    `INSERT INTO "ScanDispatchOutbox" (
      "id","operationId","attemptId","commandType","sequence","commandDigest","status",
      "attempts","availableAt","createdAt","updatedAt","commandInputJson","commandInputChecksum"
    ) VALUES ($1,$2,$3,'PREPARE',1,$4,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,$5,$6)`,
    [
      commandId,
      operation.operationId,
      attemptId,
      descriptor.commandInputChecksum,
      descriptor.commandInputJson,
      descriptor.commandInputChecksum,
    ]
  )
  await client.query(
    'UPDATE "ScanDispatchOperation" SET "state"=\'PREPARING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
    [operation.operationId]
  )
  const checked = await client.query<{ authorityAcceptedAt: Date; authorityDeadlineAt: Date }>(
    'SELECT "authorityAcceptedAt" AT TIME ZONE \'UTC\' AS "authorityAcceptedAt","authorityDeadlineAt" AT TIME ZONE \'UTC\' AS "authorityDeadlineAt" FROM "ScanDispatchAttempt" WHERE "operationId"=$1',
    [operation.operationId]
  )
  return {
    waiting: false as const,
    state: "PREPARING" as const,
    attemptId,
    commandId,
    ...checked.rows[0]!,
  }
}

export async function prepareDispatch(
  ctx: DispatchBrokerContext,
  input: PrepareDispatchInput
): Promise<PrepareDispatchResult> {
  if (ctx.preparationAuthority !== "checked-intent-v1" || !ctx.compilePreparation)
    throw new ScanDispatchAuthorityError(
      "PREPARATION_AUTHORITY_CLOSED",
      "Checked preparation authority is not installed"
    )
  const compilePreparation = ctx.compilePreparation
  try {
    const expiresAt = timestampWithoutTimeZone(input.expiresAt)
    const outcome = await ctx.transaction(input.operationId, async (client) => {
      const operation = await ctx.lockOperation(client, input)
      await checkPrepareGrant(client, input, expiresAt)
      const authority = await checkPreparationAuthority(client, operation, expiresAt)
      const replay = await readPrepareReplay(client, input)
      if (replay) {
        if (operation.state !== "PREPARING")
          throw new ScanDispatchAuthorityError(
            "DISPATCH_OPERATION_STATE_INVALID",
            "Preparation replay requires original PREPARING intent"
          )
        await requireBrokerQueuePublication(
          client,
          { operationId: operation.operationId, workspaceId: operation.workspaceId },
          true
        )
        return withPreparationAcknowledgementDeadline(
          {
            state: "PREPARING" as const,
            attemptId: replay.attemptId,
            commandId: replay.commandId,
            authorityAcceptedAt: replay.authorityAcceptedAt,
            authorityDeadlineAt: replay.authorityDeadlineAt,
          },
          authority
        )
      }
      if (!["QUEUED", "WAITING_CAPACITY"].includes(operation.state))
        throw new ScanDispatchAuthorityError(
          "DISPATCH_OPERATION_STATE_INVALID",
          `Operation ${operation.operationId} cannot prepare from ${operation.state}`
        )
      const { payload } = await requireBrokerQueuePublication(client, {
        operationId: operation.operationId,
        workspaceId: operation.workspaceId,
      })
      if (await checkPrepareCapacity(client, operation)) return { waiting: true as const }
      const { digest, scanRow } = await loadPrepareScope(client, operation)
      return withPreparationAcknowledgementDeadline(
        await createPrepareAttempt(
          client,
          operation,
          digest,
          scanRow,
          input,
          expiresAt,
          payload.focus === undefined ? null : scanQueueDigest(JSON.stringify(payload.focus)),
          compilePreparation,
          payload.focus
        ),
        authority
      )
    })
    if (outcome.kind === "unknown") return outcome
    if (!("state" in outcome.value))
      return { kind: "waiting", operationId: input.operationId, state: "WAITING_CAPACITY" }
    const result = {
      kind: "committed" as const,
      operationId: input.operationId,
      state: outcome.value.state,
      attemptId: outcome.value.attemptId,
      commandId: outcome.value.commandId,
      authorityAcceptedAt: outcome.value.authorityAcceptedAt,
      authorityDeadlineAt: outcome.value.authorityDeadlineAt,
      eligibility: "CHECKED_INTENT_ONLY" as const,
    }
    // After transaction finalizers and this caller continuation; no await or
    // untrusted getters remain between this elapsed check and the return.
    if (preparationAcknowledgementDeadlinePassed(outcome.value.acknowledgementDeadlineMonotonicMs))
      return {
        kind: "unknown",
        operationId: result.operationId,
        reasonCode: "PREPARATION_ACKNOWLEDGEMENT_DEADLINE",
      }
    return result
  } catch (error) {
    if (error instanceof ScanDispatchAuthorityError) throw error
    throw new ScanDispatchAuthorityError("DATABASE_REJECTED", "Preparation transaction rejected", {
      cause: error,
    })
  }
}

async function requireBrokerQueuePublication(
  client: pg.PoolClient,
  scope: { operationId: string; workspaceId: string },
  replay = false
) {
  try {
    return await requirePublishedScanQueueAuthority(client, scope, replay)
  } catch (error) {
    if (!(error instanceof ScanQueueOutboxError)) throw error
    throw new ScanDispatchAuthorityError(
      [
        "QUEUE_ADMISSION_SCOPE_CHANGED",
        "QUEUE_PAYLOAD_IDENTITY_CHANGED",
        "QUEUE_ADMITTED_PLAN_INVALID",
      ].includes(error.code)
        ? "DISPATCH_SCOPE_CHANGED"
        : "QUEUE_PUBLICATION_NOT_CONFIRMED",
      "Queue publication authority is unavailable",
      { cause: error }
    )
  }
}

async function checkStartUnmeteredGrant(
  client: pg.PoolClient,
  input: StartUnmeteredDispatchInput
): Promise<void> {
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
}

type StartUnmeteredAttemptRow = {
  attemptId: string
  scanId: string
  operationId: string
  maxBudgetUsd: string
  maxRuntimeMs: number
  policyDigest: string
  workerInstanceGrantId: string
  authorityEpochId: string
  scanStatus: string
}

async function loadStartUnmeteredAttempt(
  client: pg.PoolClient,
  input: StartUnmeteredDispatchInput
): Promise<StartUnmeteredAttemptRow> {
  const attempt = await client.query<StartUnmeteredAttemptRow>(
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
  return attemptRow
}

async function readStartUnmeteredReplay(
  client: pg.PoolClient,
  input: StartUnmeteredDispatchInput
): Promise<{ startId: string; commandId: string } | null> {
  const existing = await client.query<{ startId: string; commandId: string }>(
    `SELECT st."startId", o."id" AS "commandId"
     FROM "ScanDispatchStart" st
     JOIN "ScanDispatchOutbox" o ON o."operationId"=st."operationId"
       AND o."attemptId"=st."attemptId" AND o."commandType"='START_UNMETERED'
     WHERE st."operationId"=$1 AND st."attemptId"=$2`,
    [input.operationId, input.attemptId]
  )
  return existing.rows[0] ?? null
}

async function checkStartUnmeteredPreparation(
  client: pg.PoolClient,
  operation: LockedOperation,
  input: StartUnmeteredDispatchInput
): Promise<void> {
  if (operation.state !== "PREPARED")
    throw new ScanDispatchAuthorityError(
      "DISPATCH_OPERATION_STATE_INVALID",
      `Unmetered start requires PREPARED, found ${operation.state}`
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
}

async function writeStartUnmeteredRecords(
  client: pg.PoolClient,
  input: StartUnmeteredDispatchInput,
  attemptRow: StartUnmeteredAttemptRow
): Promise<{ state: "START_PENDING"; attemptId: string; startId: string; commandId: string }> {
  const reservation = await client.query<{
    accountId: string
    state: string
    runtimeLimitMs: number
  }>(
    `SELECT "accountId", "state", "runtimeLimitMs"
     FROM "ScanCapacityReservation" WHERE "scanId"=$1 FOR UPDATE`,
    [attemptRow.scanId]
  )
  const funding = reservation.rows[0]
  if (!funding || funding.state !== "RESERVED")
    throw new ScanDispatchAuthorityError("CAPACITY_NOT_READY", "Reservation is not ready")
  if (!["QUEUED", "PREFLIGHT"].includes(attemptRow.scanStatus))
    throw new ScanDispatchAuthorityError(
      "DISPATCH_OPERATION_STATE_INVALID",
      "Scan is not startable"
    )
  const maxBudgetUsd = Number(attemptRow.maxBudgetUsd)
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd !== 0)
    throw new ScanDispatchAuthorityError(
      "CAPACITY_NOT_READY",
      "Unmetered start requires a zero budget"
    )
  const maxRuntimeMs = Math.min(attemptRow.maxRuntimeMs, funding.runtimeLimitMs)
  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs <= 0)
    throw new ScanDispatchAuthorityError(
      "CAPACITY_NOT_READY",
      "Unmetered start requires runtime capacity"
    )
  const startId = createId()
  const commandId = createId()
  const fundingDigest = valueDigest("dispatch-funding/1", {
    scanId: attemptRow.scanId,
    maxRuntimeMs,
    mode: "UNMETERED",
  })

  await client.query(
    'UPDATE "Scan" SET "status"=\'RUNNING\', "startedAt"=coalesce("startedAt",CURRENT_TIMESTAMP), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
    [attemptRow.scanId]
  )
  await client.query(
    `INSERT INTO "ScanDispatchStart" (
      "startId","operationId","attemptId","kind","maxBudgetUsd","maxRuntimeMs",
      "policyDigest","fundingDigest","billableClaimEventId","providerGrantDigest","createdAt"
    ) VALUES ($1,$2,$3,'UNMETERED',0,$4,$5,$6,NULL,NULL,CURRENT_TIMESTAMP)`,
    [
      startId,
      input.operationId,
      input.attemptId,
      maxRuntimeMs,
      attemptRow.policyDigest,
      fundingDigest,
    ]
  )
  await client.query(
    `INSERT INTO "ScanDispatchOutbox" (
      "id","operationId","attemptId","commandType","sequence","commandDigest","status",
      "attempts","availableAt","createdAt","updatedAt"
    ) VALUES ($1,$2,$3,'START_UNMETERED',2,$4,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      commandId,
      input.operationId,
      input.attemptId,
      commandDigest("START_UNMETERED", input.operationId, input.attemptId),
    ]
  )
  await client.query(
    'UPDATE "ScanDispatchOperation" SET "state"=\'START_PENDING\', "updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1',
    [input.operationId]
  )
  return { state: "START_PENDING" as const, attemptId: input.attemptId, startId, commandId }
}

export async function startUnmeteredDispatch(
  ctx: DispatchBrokerContext,
  input: StartUnmeteredDispatchInput
): Promise<StartUnmeteredDispatchResult> {
  try {
    const outcome = await ctx.transaction(input.operationId, async (client) => {
      const operation = await ctx.lockOperation(client, input)
      await checkStartUnmeteredGrant(client, input)
      const attemptRow = await loadStartUnmeteredAttempt(client, input)
      const replay = await readStartUnmeteredReplay(client, input)
      if (replay)
        return {
          state: "START_PENDING" as const,
          attemptId: input.attemptId,
          startId: replay.startId,
          commandId: replay.commandId,
        }
      await checkStartUnmeteredPreparation(client, operation, input)
      return await writeStartUnmeteredRecords(client, input, attemptRow)
    })
    if (outcome.kind === "unknown") return outcome
    return { kind: "committed", operationId: input.operationId, ...outcome.value }
  } catch (error) {
    if (error instanceof ScanDispatchAuthorityError) throw error
    throw new ScanDispatchAuthorityError(
      "DATABASE_REJECTED",
      "Unmetered-start transaction rejected",
      {
        cause: error,
      }
    )
  }
}
