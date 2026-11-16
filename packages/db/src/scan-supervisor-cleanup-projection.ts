import { createId } from "@paralleldrive/cuid2"
import type pg from "pg"
import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"

type CleanupStatus = "STOPPED" | "NEVER_DISPATCHED"
type Command = { id: string; attemptId: string; commandType: string }

/** Called only after the original and wrapper histories and their current head are authenticated. */
export async function applyAuthenticatedCleanup(
  client: pg.PoolClient,
  operationId: string,
  command: Command,
  terminalReceiptId: string,
  status: string
): Promise<boolean> {
  if (
    !["STOP", "RECONCILE"].includes(command.commandType) ||
    !["STOPPED", "NEVER_DISPATCHED"].includes(status)
  )
    return false
  const proof = (
    await client.query<{
      state: string
      revision: number
      authorityEpochId: string
      lastReceiptId: string | null
      commandStatus: string
      stopReceiptId: string | null
      unresolved: boolean
      unobserved: boolean
    }>(
      `SELECT p.state::text,p.revision,p."authorityEpochId",p."lastReceiptId",c.status::text AS "commandStatus",
    (SELECT r.id FROM "ScanSupervisorReceipt" r JOIN "ScanDispatchOutbox" sc ON sc.id=r."commandId"
      WHERE r."operationId"=p."operationId" AND r."attemptId"=p."attemptId"
        AND sc."commandType"='STOP' AND r."eventType"='command_intent' AND r."receiptType"='COMMAND_ACCEPTED'
      ORDER BY r.sequence DESC LIMIT 1) AS "stopReceiptId",
    EXISTS(SELECT 1 FROM "ScanExecutionInvocationGuard" g WHERE g."operationId"=p."operationId"
      AND g."attemptId"=p."attemptId" AND g."workspaceId"=app.current_workspace_id()
      AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" n WHERE n."guardId"=g.id)) AS unresolved,
    EXISTS(SELECT 1 FROM "ScanDispatchOutbox" pending WHERE pending."operationId"=p."operationId"
      AND pending.status NOT IN ('COMPLETED','REJECTED') AND NOT EXISTS(SELECT 1 FROM "ScanSupervisorReceipt" seen
        WHERE seen."commandId"=pending.id AND seen."receiptType"<>'UNKNOWN' AND seen."journalRecordId" IS NOT NULL)) AS unobserved
    FROM "ScanPhysicalExecution" p JOIN "ScanDispatchOutbox" c ON c."operationId"=p."operationId" AND c."attemptId"=p."attemptId"
    JOIN "ScanSupervisorReceipt" terminal ON terminal.id=$4 AND terminal."commandId"=c.id
      AND terminal."operationId"=p."operationId" AND terminal."attemptId"=p."attemptId"
      AND terminal."authorityEpochId"=p."authorityEpochId" AND terminal."eventType"='command_terminal'
      AND terminal."terminalStatus"=$5 AND terminal."receiptType"::text=$5
    JOIN "ScanSupervisorJournalRecord" original ON original.id=terminal."journalRecordId"
    JOIN "ScanSupervisorJournalStream" stream ON stream.id=original."streamId" AND original.sequence<=stream."confirmedSequence"
    WHERE c.id=$1 AND p."operationId"=$2 AND p."attemptId"=$3 AND p."workspaceId"=app.current_workspace_id()
    FOR UPDATE OF p,c`,
      [command.id, operationId, command.attemptId, terminalReceiptId, status]
    )
  ).rows[0]
  if (!proof || proof.unresolved || proof.unobserved) return false
  if (["STOPPED", "NEVER_DISPATCHED"].includes(proof.state)) return proof.state === status
  // A fresh reconciliation resolves the historical UNKNOWN; the original command remains history.
  if (
    (proof.state === "UNKNOWN" || proof.commandStatus === "UNKNOWN") &&
    command.commandType !== "RECONCILE"
  )
    return false
  if (proof.commandStatus === "UNKNOWN") return false // issue a new reconciliation rather than replaying an uncertain one
  if (
    ["RESERVED", "DISPATCH_PENDING", "ACTIVE"].includes(proof.state) &&
    !proof.stopReceiptId &&
    !(proof.state === "RESERVED" && status === "NEVER_DISPATCHED")
  )
    return false
  if (proof.state === "CLEANUP_PENDING" && status !== "STOPPED") return false
  if (proof.commandStatus !== "COMPLETED") {
    if (proof.commandStatus !== "ACCEPTED")
      await client.query(
        `UPDATE "ScanDispatchOutbox" SET status='ACCEPTED',"deliveredAt"=coalesce("deliveredAt",(SELECT "observedAt" FROM "ScanSupervisorReceipt" WHERE id=$2)),"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
        [command.id, terminalReceiptId]
      )
    await client.query(
      `UPDATE "ScanDispatchOutbox" SET status='COMPLETED',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`,
      [command.id]
    )
  }
  // Closing interrupted commands is a rejection, never a fabricated PREPARE/START acknowledgement.
  await client.query(
    `UPDATE "ScanDispatchOutbox" SET status='REJECTED',"deliveredAt"=coalesce("deliveredAt",(SELECT "observedAt" FROM "ScanSupervisorReceipt" WHERE id=$2)),"updatedAt"=CURRENT_TIMESTAMP
    WHERE "operationId"=$1 AND status NOT IN ('COMPLETED','REJECTED')`,
    [operationId, terminalReceiptId]
  )
  let state = proof.state
  let revision = proof.revision
  async function transition(toState: string, receiptId: string) {
    await client.query(
      `INSERT INTO "ScanPhysicalExecutionTransition"(id,"attemptId","operationId",revision,"fromState","toState","supervisorReceiptId") VALUES($1,$2,$3,$4,$5::"ScanPhysicalExecutionState",$6::"ScanPhysicalExecutionState",$7)`,
      [createId(), command.attemptId, operationId, ++revision, state, toState, receiptId]
    )
    state = toState
  }
  if (
    ["RESERVED", "DISPATCH_PENDING", "ACTIVE"].includes(state) &&
    !(state === "RESERVED" && status === "NEVER_DISPATCHED")
  )
    await transition("STOP_REQUESTED", proof.stopReceiptId!)
  await transition(status, terminalReceiptId)
  await client.query(
    `UPDATE "ScanDispatchOperation" SET state='TERMINATED',"terminalReason"='AUTHENTICATED_EXECUTOR_CLEANUP',"updatedAt"=CURRENT_TIMESTAMP WHERE "operationId"=$1 AND "workspaceId"=app.current_workspace_id()`,
    [operationId]
  )
  // This records physical release only. Money/slot release happens after this transaction commits.
  const release = {
    schema: "lyrashield-dispatch-release/1",
    operationId,
    attemptId: command.attemptId,
    authorityEpochId: proof.authorityEpochId,
    physicalState: status as CleanupStatus,
    supervisorReceiptId: terminalReceiptId,
  }
  await client.query(
    `INSERT INTO "ScanDispatchReleaseReceipt"(id,"operationId","attemptId","authorityEpochId","physicalState","supervisorReceiptId","releaseDigest","capacityDisposition")
    VALUES($1,$2,$3,$4,$5::"ScanPhysicalExecutionState",$6,$7,'REVIEW_REQUIRED') ON CONFLICT("operationId") DO NOTHING`,
    [
      createId(),
      operationId,
      command.attemptId,
      proof.authorityEpochId,
      status,
      terminalReceiptId,
      sha256Hex(canonicalJson(release)),
    ]
  )
  return true
}
