import { createHash } from "node:crypto"
import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import type {
  DispatchBrokerResult,
  DispatchOperationState,
  PrepareDispatchInput,
  PrepareDispatchResult,
  StartPaidDispatchInput,
  StartPaidDispatchResult,
} from "./scan-dispatch-authority-broker"

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

export type TransactionOutcome<T extends object> =
  | { kind: "committed"; operationId: string; value: T }
  | Extract<DispatchBrokerResult, { kind: "unknown" }>

export type DispatchBrokerContext = {
  transaction: <T>(
    operationId: string,
    work: (client: pg.PoolClient) => Promise<T>
  ) => Promise<TransactionOutcome<T & object>>
  lockOperation: (
    client: pg.PoolClient,
    input: Pick<PrepareDispatchInput, "operationId" | "authorityEpochId">
  ) => Promise<LockedOperation>
}

function commandDigest(commandType: string, operationId: string, attemptId: string): string {
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

async function readPrepareReplay(
  client: pg.PoolClient,
  input: PrepareDispatchInput
): Promise<{
  attemptId: string
  commandId: string
  workerInstanceId: string
  workerInstanceGrantId: string
  authorityEpochId: string
} | null> {
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
  const row = existing.rows[0]
  if (!row) return null
  if (
    row.workerInstanceId !== input.workerInstanceId ||
    row.workerInstanceGrantId !== input.workerGrantId ||
    row.authorityEpochId !== input.authorityEpochId
  )
    throw new ScanDispatchAuthorityError(
      "DISPATCH_REPLAY_CONFLICT",
      "Preparation replay changed worker authority"
    )
  return row
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
  expiresAt: string
): Promise<{ waiting: false; state: "PREPARING"; attemptId: string; commandId: string }> {
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
}

export async function prepareDispatch(
  ctx: DispatchBrokerContext,
  input: PrepareDispatchInput
): Promise<PrepareDispatchResult> {
  try {
    const expiresAt = timestampWithoutTimeZone(input.expiresAt)
    const outcome = await ctx.transaction(input.operationId, async (client) => {
      const operation = await ctx.lockOperation(client, input)
      await checkPrepareGrant(client, input, expiresAt)
      const replay = await readPrepareReplay(client, input)
      if (replay)
        return { state: "PREPARING" as const, attemptId: replay.attemptId, commandId: replay.commandId }
      if (!["QUEUED", "WAITING_CAPACITY"].includes(operation.state))
        throw new ScanDispatchAuthorityError(
          "DISPATCH_OPERATION_STATE_INVALID",
          `Operation ${operation.operationId} cannot prepare from ${operation.state}`
        )
      if (await checkPrepareCapacity(client, operation)) return { waiting: true as const }
      const { digest, scanRow } = await loadPrepareScope(client, operation)
      return await createPrepareAttempt(client, operation, digest, scanRow, input, expiresAt)
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

async function checkStartPaidGrant(
  client: pg.PoolClient,
  input: StartPaidDispatchInput
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

type StartPaidAttemptRow = {
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

async function loadStartPaidAttempt(
  client: pg.PoolClient,
  input: StartPaidDispatchInput
): Promise<StartPaidAttemptRow> {
  const attempt = await client.query<StartPaidAttemptRow>(
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

async function readStartPaidReplay(
  client: pg.PoolClient,
  input: StartPaidDispatchInput
): Promise<{ startId: string; commandId: string } | null> {
  const existing = await client.query<{ startId: string; commandId: string }>(
    `SELECT st."startId", o."id" AS "commandId"
     FROM "ScanDispatchStart" st
     JOIN "ScanDispatchOutbox" o ON o."operationId"=st."operationId"
       AND o."attemptId"=st."attemptId" AND o."commandType"='START_PAID'
     WHERE st."operationId"=$1 AND st."attemptId"=$2`,
    [input.operationId, input.attemptId]
  )
  return existing.rows[0] ?? null
}

async function checkStartPaidPreparation(
  client: pg.PoolClient,
  operation: LockedOperation,
  input: StartPaidDispatchInput
): Promise<void> {
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
}

type StartPaidFunding = {
  accountId: string
  state: string
  fundedMinutes: number
  runtimeLimitMs: number
  poolMinutes: number
  packMinutes: number
  graceMinutes: number
  overageMinutes: number
}

async function loadStartPaidFunding(
  client: pg.PoolClient,
  attemptRow: StartPaidAttemptRow
): Promise<{ funding: StartPaidFunding; maxBudgetUsd: number; maxRuntimeMs: number }> {
  const reservation = await client.query<StartPaidFunding>(
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
  return { funding, maxBudgetUsd, maxRuntimeMs }
}

async function writeStartPaidRecords(
  client: pg.PoolClient,
  input: StartPaidDispatchInput,
  attemptRow: StartPaidAttemptRow,
  funding: StartPaidFunding,
  maxBudgetUsd: number,
  maxRuntimeMs: number
): Promise<{ state: "START_PENDING"; attemptId: string; startId: string; commandId: string }> {
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
}

export async function startPaidDispatch(
  ctx: DispatchBrokerContext,
  input: StartPaidDispatchInput
): Promise<StartPaidDispatchResult> {
  try {
    const outcome = await ctx.transaction(input.operationId, async (client) => {
      const operation = await ctx.lockOperation(client, input)
      await checkStartPaidGrant(client, input)
      const attemptRow = await loadStartPaidAttempt(client, input)
      const replay = await readStartPaidReplay(client, input)
      if (replay)
        return {
          state: "START_PENDING" as const,
          attemptId: input.attemptId,
          startId: replay.startId,
          commandId: replay.commandId,
        }
      await checkStartPaidPreparation(client, operation, input)
      const { funding, maxBudgetUsd, maxRuntimeMs } = await loadStartPaidFunding(client, attemptRow)
      return await writeStartPaidRecords(
        client,
        input,
        attemptRow,
        funding,
        maxBudgetUsd,
        maxRuntimeMs
      )
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
