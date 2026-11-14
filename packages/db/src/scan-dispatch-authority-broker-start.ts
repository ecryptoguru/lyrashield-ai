import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { canonicalJson, sha256Hex, type SupervisorAttemptProof } from "@lyrashield/runtime-control"
import {
  ScanDispatchAuthorityError,
  commandDigest,
  valueDigest,
} from "./scan-dispatch-authority-broker-methods"
import type {
  DispatchBrokerContext,
  LockedOperation,
} from "./scan-dispatch-authority-broker-methods"
import type {
  StartPaidDispatchInput,
  StartPaidDispatchResult,
} from "./scan-dispatch-authority-broker"

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
  input: StartPaidDispatchInput,
  stage = false
): Promise<StartPaidAttemptRow> {
  const attempt = await client.query<StartPaidAttemptRow>(
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
  input: StartPaidDispatchInput,
  stage = false
): Promise<void> {
  if (operation.state !== "PREPARED")
    throw new ScanDispatchAuthorityError(
      "DISPATCH_OPERATION_STATE_INVALID",
      `Paid start requires PREPARED, found ${operation.state}`
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
    throw new ScanDispatchAuthorityError("CAPACITY_NOT_READY", "Funded reservation is not ready")
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
  maxRuntimeMs: number,
  stageProof?: SupervisorAttemptProof
): Promise<{ state: "START_PENDING"; attemptId: string; startId: string; commandId: string }> {
  if (stageProof && maxRuntimeMs !== attemptRow.maxRuntimeMs)
    throw new ScanDispatchAuthorityError(
      "CAPACITY_NOT_READY",
      "Funding no longer matches the immutable prepared runtime"
    )
  const startId = createId()
  const billableClaimEventId = createId()
  const commandId = stageProof?.command.commandId ?? createId()
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
      "policyDigest","fundingDigest","billableClaimEventId","providerGrantDigest","createdAt","authorityProofInputJson","authorityProofChecksum"
    ) VALUES ($1,$2,$3,'PAID',$4::numeric,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,$10,$11)`,
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
      stageProof ? canonicalJson(stageProof) : null,
      stageProof ? sha256Hex(canonicalJson(stageProof)) : null,
    ]
  )
  if (!stageProof)
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
      const attemptRow = await loadStartPaidAttempt(client, input, Boolean(ctx.stageProof))
      if (ctx.stageProof) {
        const existing = (
          await client.query<{ startId: string }>(
            `SELECT "startId" FROM "ScanDispatchStart" WHERE "operationId"=$1 AND "attemptId"=$2 AND kind='PAID' AND "authorityProofInputJson" IS NOT NULL`,
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
      const replay = await readStartPaidReplay(client, input)
      if (replay)
        return {
          state: "START_PENDING" as const,
          attemptId: input.attemptId,
          startId: replay.startId,
          commandId: replay.commandId,
        }
      await checkStartPaidPreparation(client, operation, input, Boolean(ctx.stageProof))
      const { funding, maxBudgetUsd, maxRuntimeMs } = await loadStartPaidFunding(client, attemptRow)
      return await writeStartPaidRecords(
        client,
        input,
        attemptRow,
        funding,
        maxBudgetUsd,
        maxRuntimeMs,
        ctx.stageProof
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
