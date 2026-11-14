import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { receiptFailure } from "./scan-supervisor-receipt-ingestion-verifier"

/** Completed metadata does not authorize execution or release capacity. */
export async function applyAuthenticatedPreparation(
  client: pg.PoolClient,
  operationId: string,
  command: { id: string; attemptId: string; commandType: string },
  receiptId: string
): Promise<boolean> {
  if (command.commandType !== "PREPARE") return false
  const proof = await client.query<{ complete: boolean }>(
    "SELECT app.scan_supervisor_preparation_completed($1) AS complete",
    [command.id]
  )
  if (proof.rows[0]?.complete !== true) return false
  const current = await client.query<{
    status: string
    state: string
    revision: number
    operationState: string
  }>(
    `SELECT c.status::text,p.state::text,p.revision,o.state::text AS "operationState"
    FROM "ScanDispatchOutbox" c JOIN "ScanPhysicalExecution" p ON p."attemptId"=c."attemptId" AND p."operationId"=c."operationId"
    JOIN "ScanDispatchOperation" o ON o."operationId"=c."operationId"
    WHERE c.id=$1 AND c."operationId"=$2 AND c."attemptId"=$3 FOR UPDATE OF c,p,o`,
    [command.id, operationId, command.attemptId]
  )
  const row = current.rows[0]
  if (
    row?.status === "COMPLETED" &&
    row.state === "PREPARING" &&
    ["START_PENDING", "ACTIVE", "STOPPING", "UNKNOWN"].includes(row.operationState)
  )
    return true
  if (
    row?.status === "COMPLETED" &&
    [
      "DISPATCH_PENDING",
      "ACTIVE",
      "STOP_REQUESTED",
      "CLEANUP_PENDING",
      "STOPPED",
      "NEVER_DISPATCHED",
    ].includes(row.state)
  )
    return true
  if (
    !row ||
    !["RESERVED", "PREPARING"].includes(row.state) ||
    !["PREPARING", "PREPARED"].includes(row.operationState)
  )
    receiptFailure("SUPERVISOR_PREPARATION_STATE_CONFLICT")
  if (!["ACCEPTED", "COMPLETED"].includes(row.status))
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='ACCEPTED',"deliveredAt"=coalesce("deliveredAt",(SELECT "observedAt" FROM "ScanSupervisorReceipt" WHERE id=$2)),"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
      [command.id, receiptId]
    )
  if (row.status !== "COMPLETED")
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='COMPLETED',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
      [command.id]
    )
  if (row.state === "RESERVED") {
    const intent = await client.query<{ id: string }>(
      `SELECT id FROM "ScanSupervisorReceipt" WHERE "commandId"=$1 AND "operationId"=$2 AND "attemptId"=$3 AND "eventType"='command_intent' AND "journalRecordId" IS NOT NULL ORDER BY sequence LIMIT 1`,
      [command.id, operationId, command.attemptId]
    )
    if (!intent.rows[0]) receiptFailure("SUPERVISOR_COMMAND_INTENT_UNAVAILABLE")
    await client.query(
      `INSERT INTO "ScanPhysicalExecutionTransition"(id,"attemptId","operationId",revision,"fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,$4,'RESERVED','PREPARING',$5)`,
      [createId(), command.attemptId, operationId, row.revision + 1, intent.rows[0].id]
    )
  }
  if (row.operationState !== "PREPARED")
    await client.query(
      `UPDATE "ScanDispatchOperation" SET state='PREPARED',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1`,
      [operationId]
    )
  return true
}
