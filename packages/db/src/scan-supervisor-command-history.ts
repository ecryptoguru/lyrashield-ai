import { z } from "zod"
import { canonicalJson, type AuthoritySqlConnection } from "@lyrashield/runtime-control"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"
import { authenticateRetainedSupervisorHistoryBytes } from "./scan-supervisor-authority-source-verifier"
import {
  checkReceiptKeys,
  receiptFailure,
  verifyHead,
  type SupervisorReceiptAuthority,
} from "./scan-supervisor-receipt-ingestion-verifier"

const id = z.string().min(3).max(192)
export const supervisorCommandHistoryInputSchema = z
  .object({
    streamId: id,
    authorityEpochId: id,
    commandId: id,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: id,
  })
  .strict()

export type SupervisorCommandHistoryInput = z.infer<typeof supervisorCommandHistoryInputSchema>

/** Positive historical facts only. Missing/legacy data is UNAVAILABLE, never proof of a fresh command.
 * The protected caller must retain its native authority gate and independently pinned current
 * journal state before treating a historical status as current execution authority. */
export async function readRetainedSupervisorCommand(
  client: AuthoritySqlConnection,
  input: unknown,
  authority: SupervisorReceiptAuthority
) {
  const expected = supervisorCommandHistoryInputSchema.parse(input)
  checkReceiptKeys(authority)
  if (
    expected.streamId !== authority.streamId ||
    expected.authorityEpochId !== authority.authorityEpochId
  )
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  const rows = (
    await client.query(
      `SELECT c."commandInputJson",c."commandInputChecksum",a."workspaceId",a."scanId",c."operationId",
    s."headInputJson",s."confirmedSequence"::text,app.scan_preparation_gate_held() AS held,
    intent."originalInputJson",intent."wrapperInputJson",tail."originalInputJson" AS "statusOriginalInputJson",tail."wrapperInputJson" AS "statusWrapperInputJson"
    FROM "ScanDispatchOutbox" c JOIN "ScanDispatchAttempt" a ON a."operationId"=c."operationId" AND a."attemptId"=c."attemptId"
    JOIN "ScanSupervisorJournalStream" s ON s.id=$1 AND s."authorityEpochId"=a."authorityEpochId"
      AND s."supervisorInstanceId"=$6 AND s."originalKeyHash"=$7 AND s."wrapperKeyHash"=$8
    JOIN LATERAL(SELECT j."originalInputJson",j."wrapperInputJson" FROM "ScanSupervisorReceipt" r
      JOIN "ScanSupervisorJournalRecord" j ON j.id=r."journalRecordId" AND j."streamId"=s.id AND j.sequence<=s."confirmedSequence"
      WHERE r."commandId"=c.id AND r."eventType"='command_intent' AND r."attemptId"=c."attemptId" ORDER BY r.sequence LIMIT 1) intent ON true
    JOIN LATERAL(SELECT j."originalInputJson",j."wrapperInputJson" FROM "ScanSupervisorReceipt" r
      JOIN "ScanSupervisorJournalRecord" j ON j.id=r."journalRecordId" AND j."streamId"=s.id AND j.sequence<=s."confirmedSequence"
      WHERE r."commandId"=c.id AND r."attemptId"=c."attemptId" AND r."eventType" IN ('command_intent','attempt_prepared','command_terminal','command_recovery_hold') ORDER BY (r."terminalStatus"='UNKNOWN') DESC NULLS LAST,r.sequence DESC LIMIT 1) tail ON true
    WHERE c.id=$2 AND c."attemptId"=$3 AND a."authorityEpochId"=$4 AND c."commandInputChecksum"=$5
      AND a."workspaceId"=app.current_workspace_id()`,
      [
        expected.streamId,
        expected.commandId,
        expected.attemptId,
        expected.authorityEpochId,
        expected.requestHash,
        authority.supervisorInstanceId,
        authority.originalKeyHash,
        authority.wrapperKeyHash,
      ]
    )
  ).rows
  const row = rows[0]
  if (
    rows.length !== 1 ||
    !row ||
    row.held !== true ||
    typeof row.commandInputJson !== "string" ||
    typeof row.commandInputChecksum !== "string" ||
    typeof row.headInputJson !== "string"
  )
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  const command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
  if (!command || command.commandId !== expected.commandId)
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  const intent = authenticateRetainedSupervisorHistoryBytes(
    {
      originalInputJson: String(row.originalInputJson),
      wrapperInputJson: String(row.wrapperInputJson),
    },
    authority
  )
  const status = authenticateRetainedSupervisorHistoryBytes(
    {
      originalInputJson: String(row.statusOriginalInputJson),
      wrapperInputJson: String(row.statusWrapperInputJson),
    },
    authority
  )
  const head = verifyHead(JSON.parse(row.headInputJson), authority)
  for (const record of [intent, status])
    if (
      record.wrapper.payload.operationId !== row.operationId ||
      record.wrapper.payload.attemptId !== expected.attemptId ||
      record.wrapper.payload.workspaceId !== row.workspaceId ||
      record.wrapper.payload.scanId !== row.scanId ||
      record.wrapper.sequence > head.sequence
    )
      receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  if (
    status.original.payload.type !== "command_intent" &&
    status.original.payload.commandId !== expected.commandId
  )
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  if (
    intent.original.payload.type !== "command_intent" ||
    canonicalJson(intent.original.payload.command) !== row.commandInputJson ||
    head.sequence !== Number(row.confirmedSequence)
  )
    receiptFailure("SUPERVISOR_COMMAND_HISTORY_UNAVAILABLE")
  return {
    command,
    commandInputJson: row.commandInputJson,
    requestHash: row.commandInputChecksum,
    originalInputJson: row.originalInputJson,
    wrapperInputJson: row.wrapperInputJson,
    observedStatus:
      status.original.payload.type === "command_recovery_hold"
        ? "UNKNOWN"
        : status.original.payload.type === "attempt_prepared"
          ? "PREPARED"
          : (status.original.payload.status ?? "UNKNOWN"),
    statusOriginalInputJson: row.statusOriginalInputJson,
    statusWrapperInputJson: row.statusWrapperInputJson,
    headInputJson: row.headInputJson,
    confirmedSequence: head.sequence,
  }
}
