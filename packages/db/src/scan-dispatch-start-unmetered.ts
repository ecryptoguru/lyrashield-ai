import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { canonicalJson, sha256Hex, type SupervisorAttemptProof } from "@lyrashield/runtime-control"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import {
  commandDigest,
  valueDigest,
  type DispatchBrokerContext,
  type LockedOperation,
} from "./scan-dispatch-authority-broker-methods"
import type {
  StartUnmeteredDispatchInput,
  StartUnmeteredDispatchResult,
} from "./scan-dispatch-authority-broker"

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
  input: StartUnmeteredDispatchInput,
  stage = false
): Promise<StartUnmeteredAttemptRow> {
  const attempt = await client.query<StartUnmeteredAttemptRow>(
    `SELECT a."attemptId", a."scanId", a."operationId", a."maxBudgetUsd"::text AS "maxBudgetUsd",
            a."maxRuntimeMs", a."policyDigest", a."workerInstanceGrantId", a."authorityEpochId",
            s."status"::text AS "scanStatus"
     FROM "ScanDispatchAttempt" a
     JOIN "Scan" s ON s."id" = a."scanId"
     WHERE a."operationId"=$1 AND a."attemptId"=$2
     FOR UPDATE OF ${stage ? "s" : "a, s"}`,
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
  input: StartUnmeteredDispatchInput,
  stage = false
): Promise<void> {
  if (operation.state !== "PREPARED")
    throw new ScanDispatchAuthorityError(
      "DISPATCH_OPERATION_STATE_INVALID",
      `Unmetered start requires PREPARED, found ${operation.state}`
    )
  const physical = await client.query<{ state: string }>(
    `SELECT "state"::text AS state FROM "ScanPhysicalExecution" WHERE "attemptId"=$1 ${stage ? "" : "FOR UPDATE"}`,
    [input.attemptId]
  )
  if (physical.rows[0]?.state !== "PREPARING")
    throw new ScanDispatchAuthorityError(
      "DISPATCH_OPERATION_STATE_INVALID",
      "Physical preparation is incomplete"
    )
  const preparation = await client.query<{ status: string }>(
    `SELECT "status"::text AS status FROM "ScanDispatchOutbox"
     WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType"='PREPARE' ${stage ? "" : "FOR UPDATE"}`,
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
  attemptRow: StartUnmeteredAttemptRow,
  stageProof?: SupervisorAttemptProof
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
  if (stageProof && maxRuntimeMs !== attemptRow.maxRuntimeMs)
    throw new ScanDispatchAuthorityError(
      "CAPACITY_NOT_READY",
      "Capacity no longer matches the immutable prepared runtime"
    )
  const startId = createId()
  const commandId = stageProof?.command.commandId ?? createId()
  const fundingDigest = valueDigest("dispatch-funding/1", {
    scanId: attemptRow.scanId,
    maxRuntimeMs,
    mode: "UNMETERED",
  })

  await client.query(
    'UPDATE "Scan" SET "status"=\'RUNNING\', "startedAt"=coalesce("startedAt",CURRENT_TIMESTAMP), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
    [attemptRow.scanId]
  )
  if (stageProof) {
    const capacity = await client.query(
      `UPDATE "ScanCapacityReservation" SET state='RUNNING',"updatedAt"=CURRENT_TIMESTAMP WHERE "scanId"=$1 AND state='RESERVED'`,
      [attemptRow.scanId]
    )
    if (capacity.rowCount !== 1)
      throw new ScanDispatchAuthorityError(
        "CAPACITY_NOT_READY",
        "Unmetered reservation is unavailable"
      )
  }
  await client.query(
    `INSERT INTO "ScanDispatchStart" (
      "startId","operationId","attemptId","kind","maxBudgetUsd","maxRuntimeMs",
      "policyDigest","fundingDigest","billableClaimEventId","providerGrantDigest","createdAt","authorityProofInputJson","authorityProofChecksum"
    ) VALUES ($1,$2,$3,'UNMETERED',0,$4,$5,$6,NULL,NULL,CURRENT_TIMESTAMP,$7,$8)`,
    [
      startId,
      input.operationId,
      input.attemptId,
      maxRuntimeMs,
      attemptRow.policyDigest,
      fundingDigest,
      stageProof ? canonicalJson(stageProof) : null,
      stageProof ? sha256Hex(canonicalJson(stageProof)) : null,
    ]
  )
  if (!stageProof)
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
      const attemptRow = await loadStartUnmeteredAttempt(client, input, Boolean(ctx.stageProof))
      if (ctx.stageProof) {
        const existing = (
          await client.query<{ startId: string }>(
            `SELECT "startId" FROM "ScanDispatchStart" WHERE "operationId"=$1 AND "attemptId"=$2 AND kind='UNMETERED' AND "authorityProofInputJson" IS NOT NULL`,
            [input.operationId, input.attemptId]
          )
        ).rows[0]
        if (existing)
          return {
            state: "START_PENDING" as const,
            attemptId: input.attemptId,
            startId: existing.startId,
            commandId: ctx.stageProof.command.commandId,
          }
      }
      const replay = await readStartUnmeteredReplay(client, input)
      if (replay)
        return {
          state: "START_PENDING" as const,
          attemptId: input.attemptId,
          startId: replay.startId,
          commandId: replay.commandId,
        }
      await checkStartUnmeteredPreparation(client, operation, input, Boolean(ctx.stageProof))
      return await writeStartUnmeteredRecords(client, input, attemptRow, ctx.stageProof)
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
