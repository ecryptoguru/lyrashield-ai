import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { receiptFailure } from "./scan-supervisor-receipt-ingestion-verifier"

/** Signed START terminal alone is insufficient: both exact native ACKs must be retained. */
export async function applyAuthenticatedStart(
  client: pg.PoolClient,
  operationId: string,
  command: { id: string; attemptId: string; commandType: string },
  terminalReceiptId: string
): Promise<boolean> {
  if (!["START_PAID", "START_UNMETERED"].includes(command.commandType)) return false
  const proof = (
    await client.query<{ createReceiptId: string; startedReceiptId: string }>(
      `SELECT cr."receiptId" AS "createReceiptId",r.id AS "startedReceiptId"
    FROM "ScanDispatchOutbox" c JOIN "ScanDispatchStart" s ON s."operationId"=c."operationId" AND s."attemptId"=c."attemptId"
    JOIN "ScanExecutionInvocationGuard" cg ON cg."commandId"=c.id AND cg."operationId"=c."operationId" AND cg."attemptId"=c."attemptId" AND cg.phase='EXECUTOR_CREATE'
    JOIN "ScanExecutionInvocationResolution" cr ON cr."guardId"=cg.id
    JOIN "ScanExecutionInvocationGuard" sg ON sg."commandId"=c.id AND sg."operationId"=c."operationId" AND sg."attemptId"=c."attemptId" AND sg.phase='EXECUTOR_START' AND sg."executorKey"=cg."executorKey"
    JOIN "ScanExecutionInvocationResolution" sr ON sr."guardId"=sg.id
    JOIN "ScanSupervisorReceipt" r ON r."commandId"=c.id AND r."operationId"=c."operationId" AND r."attemptId"=c."attemptId" AND r."eventType"='resource_started' AND r."executorKey"=sg."executorKey" AND r."journalRecordId" IS NOT NULL
    WHERE c.id=$1 AND c."operationId"=$2 AND c."attemptId"=$3 AND c."authorityProofInputJson" IS NOT NULL AND s."authorityProofInputJson" IS NOT NULL
      AND cg."actionChecksum"=c."commandInputChecksum" AND sg."actionChecksum"=c."commandInputChecksum"
      AND cg."workspaceId"=app.current_workspace_id() AND sg."workspaceId"=app.current_workspace_id()`,
      [command.id, operationId, command.attemptId]
    )
  ).rows[0]
  if (!proof) return false
  const row = (
    await client.query<{ state: string; revision: number; status: string }>(
      `SELECT p.state::text,p.revision,c.status::text FROM "ScanPhysicalExecution" p JOIN "ScanDispatchOutbox" c ON c."attemptId"=p."attemptId" AND c."operationId"=p."operationId"
    WHERE c.id=$1 AND p."operationId"=$2 FOR UPDATE OF p,c`,
      [command.id, operationId]
    )
  ).rows[0]
  if (row?.status === "COMPLETED") {
    if (!["ACTIVE", "STOP_REQUESTED", "CLEANUP_PENDING", "STOPPED", "UNKNOWN"].includes(row.state))
      receiptFailure("SUPERVISOR_START_STATE_CONFLICT")
    const history = (
      await client.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM "ScanPhysicalExecutionTransition" t
        JOIN "ScanSupervisorReceipt" active ON active.id=t."supervisorReceiptId" AND active."operationId"=t."operationId" AND active."attemptId"=t."attemptId"
        JOIN "ScanSupervisorReceipt" started ON started.id=$4 AND started."operationId"=t."operationId" AND started."attemptId"=t."attemptId"
        JOIN "ScanDispatchAttempt" a ON a."operationId"=t."operationId" AND a."attemptId"=t."attemptId"
        WHERE t."operationId"=$1 AND t."attemptId"=$2 AND t.revision<=$3 AND t."toState"='ACTIVE'
          AND a."workspaceId"=app.current_workspace_id() AND active."eventType"='resource_started' AND active."journalRecordId" IS NOT NULL
          AND active."supervisorInstanceId"=started."supervisorInstanceId" AND active."authorityEpochId"=started."authorityEpochId" AND active.sequence<=started.sequence) AS present`,
        [operationId, command.attemptId, row.revision, proof.startedReceiptId]
      )
    ).rows[0]
    if (history?.present !== true) receiptFailure("SUPERVISOR_START_STATE_CONFLICT")
    // Re-observing an authenticated completed command cannot rewrite its later
    // cleanup or UNKNOWN state. The immutable ACTIVE transition proves history.
    return true
  }
  if (!row || !["PREPARING", "DISPATCH_PENDING", "ACTIVE"].includes(row.state))
    receiptFailure("SUPERVISOR_START_STATE_CONFLICT")
  let revision = row.revision
  if (row.state === "PREPARING")
    await client.query(
      `INSERT INTO "ScanPhysicalExecutionTransition"(id,"attemptId","operationId",revision,"fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,$4,'PREPARING','DISPATCH_PENDING',$5)`,
      [createId(), command.attemptId, operationId, ++revision, proof.createReceiptId]
    )
  if (row.state !== "ACTIVE")
    await client.query(
      `INSERT INTO "ScanPhysicalExecutionTransition"(id,"attemptId","operationId",revision,"fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,$4,'DISPATCH_PENDING','ACTIVE',$5)`,
      [createId(), command.attemptId, operationId, ++revision, proof.startedReceiptId]
    )
  if (!["ACCEPTED", "COMPLETED"].includes(row.status))
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='ACCEPTED',"deliveredAt"=coalesce("deliveredAt",(SELECT "observedAt" FROM "ScanSupervisorReceipt" WHERE id=$2)),"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
      [command.id, terminalReceiptId]
    )
  if (row.status !== "COMPLETED")
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='COMPLETED',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
      [command.id]
    )
  await client.query(
    `UPDATE "ScanDispatchOperation" SET state='ACTIVE',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1 AND "workspaceId"=app.current_workspace_id() AND state='START_PENDING'`,
    [operationId]
  )
  return true
}
