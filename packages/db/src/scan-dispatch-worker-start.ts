import { z } from "zod"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import { ScanDispatchAuthorityError } from "./scan-dispatch-authority-error"
import {
  requireScanDispatchWorkerAssignment,
  scanDispatchWorkerRequestOperation,
} from "./scan-dispatch-worker-assignment"
import type { DispatchBrokerContext } from "./scan-dispatch-authority-broker-methods"
import type { StartPaidDispatchInput } from "./scan-dispatch-authority-broker"

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
export const workerDispatchInputSchema = z
  .object({
    operationId: id,
    attemptId: id,
    workerInstanceId: id,
    workerGrantId: id,
    authorityEpochId: id,
  })
  .strict()
export type WorkerDispatchInput = z.infer<typeof workerDispatchInputSchema>

function unavailable(): never {
  throw new ScanDispatchAuthorityError(
    "PREPARATION_AUTHORITY_UNAVAILABLE",
    "Prepared worker dispatch is unavailable"
  )
}

/** Select an installed executor from the exact confirmed PREPARE, never worker input. */
export async function selectPreparedWorkerStart(
  context: DispatchBrokerContext,
  value: WorkerDispatchInput
) {
  const input = workerDispatchInputSchema.parse(value)
  if (scanDispatchWorkerRequestOperation() !== input.operationId)
    throw new ScanDispatchAuthorityError(
      "WORKER_GRANT_INVALID",
      "Original worker authority is required"
    )
  const selected = await context.transaction(input.operationId, async (client) => {
    await client.query("SELECT app.require_scan_preparation_role()")
    await requireScanDispatchWorkerAssignment(client, input.operationId)
    const operation = await context.lockOperation(client, input)
    if (!["PREPARED", "START_PENDING", "ACTIVE"].includes(operation.state)) unavailable()
    const rows = await client.query<{
      id: string
      commandInputJson: string
      commandInputChecksum: string
      workerGrantId: string
      workerInstanceId: string
      authorityEpochId: string
    }>(
      `SELECT p.id,p."commandInputJson",p."commandInputChecksum",
      a."workerInstanceGrantId" AS "workerGrantId",g."instanceId" AS "workerInstanceId",a."authorityEpochId"
      FROM "ScanDispatchOutbox" p JOIN "ScanDispatchAttempt" a ON a."operationId"=p."operationId" AND a."attemptId"=p."attemptId"
      JOIN "ScanWorkerInstanceGrant" g ON g.id=a."workerInstanceGrantId" AND g."authorityEpochId"=a."authorityEpochId"
      WHERE p."operationId"=$1 AND p."attemptId"=$2 AND p."commandType"='PREPARE' AND p.status='COMPLETED'
        AND a."workspaceId"=app.current_workspace_id() AND a."authorityAcceptedAt" IS NOT NULL`,
      [input.operationId, input.attemptId]
    )
    if (rows.rows.length !== 1) unavailable()
    const row = rows.rows[0]!
    const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    if (
      !command ||
      command.type !== "PREPARE" ||
      command.commandId !== row.id ||
      command.attempt.attemptId !== input.attemptId ||
      command.attempt.operationId !== input.operationId ||
      command.attempt.workspaceId !== operation.workspaceId ||
      command.attempt.scanId !== operation.scanId ||
      command.attempt.authorityEpochId !== input.authorityEpochId ||
      command.attempt.workerIdentity !== input.workerInstanceId ||
      row.workerGrantId !== input.workerGrantId ||
      row.workerInstanceId !== input.workerInstanceId ||
      row.authorityEpochId !== input.authorityEpochId
    )
      unavailable()
    const keys = command.executors.map((executor) => executor.key)
    if (new Set(keys).size !== keys.length) unavailable()
    const starts = await client.query<{ executorKey: string; status: string }>(
      `SELECT "executorKey",status::text FROM "ScanDispatchOutbox"
      WHERE "operationId"=$1 AND "attemptId"=$2 AND "commandType" IN ('START_PAID','START_UNMETERED')`,
      [input.operationId, input.attemptId]
    )
    if (starts.rows.some((start) => start.status !== "COMPLETED"))
      throw new ScanDispatchAuthorityError(
        "PREPARATION_AUTHORITY_BUSY",
        "Prior executor dispatch is retained"
      )
    const started = starts.rows.map((start) => start.executorKey)
    if (
      new Set(started).size !== started.length ||
      started.some((key) => !keys.includes(key as (typeof keys)[number]))
    )
      unavailable()
    const executorKey = keys.find((key) => !started.includes(key))
    return executorKey
      ? {
          input: { ...input, executorKey } satisfies StartPaidDispatchInput,
          kind: command.attempt.billingMode,
        }
      : { input: null, kind: command.attempt.billingMode }
  })
  return selected
}
