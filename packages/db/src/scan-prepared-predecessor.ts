import { z } from "zod"
import {
  canonicalJson,
  sha256Hex,
  type AuthoritySqlConnection,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import type { SupervisorReceiptAuthority } from "./scan-supervisor-receipt-ingestion-verifier"
import { readRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source"
import { authenticateRetainedSupervisorAuthoritySource } from "./scan-supervisor-authority-source-verifier"
import { verifyPrepareInvocationCompleted } from "./scan-supervisor-native-invocation-resolution"

function unavailable(): never {
  throw new Error("Authenticated completed preparation is unavailable")
}
/** Preserve the genuine prepared event; it is never rewritten as a terminal receipt. */
export function assertPreparedEventMatchesCommand(event: unknown, command: PrepareCommand): void {
  const parsed = z
    .object({
      type: z.string(),
      commandId: z.string(),
      binding: z.unknown().optional(),
      executors: z.unknown().optional(),
      provider: z.unknown().optional(),
      status: z.string().optional(),
    })
    .passthrough()
    .parse(event)
  if (parsed.commandId !== command.commandId) unavailable()
  if (parsed.type === "command_terminal" && parsed.status === "PREPARED") return
  if (
    parsed.type !== "attempt_prepared" ||
    canonicalJson(parsed.binding) !== canonicalJson(command.attempt) ||
    canonicalJson(parsed.executors) !== canonicalJson(command.executors) ||
    canonicalJson(parsed.provider ?? null) !== canonicalJson(command.provider ?? null)
  )
    unavailable()
}
export async function assertPreparedInvocationCompleted(
  connection: AuthoritySqlConnection,
  authority: SupervisorReceiptAuthority,
  command: PrepareCommand,
  prepared: Awaited<ReturnType<typeof authenticateRetainedSupervisorAuthoritySource>>
): Promise<void> {
  assertPreparedEventMatchesCommand(prepared.original.payload, command)
  if (prepared.original.payload.type === "command_terminal") return
  const rows = (
    await connection.query(
      `SELECT g.id,g."operationId",g."attemptId",g."authorityEpochId",g.phase,g."commandId",g."executorKey",g."actionChecksum",g."bindingInputJson",r."proofInputJson",r."proofChecksum",receipt."receiptHash",record.sequence::text
 FROM "ScanExecutionInvocationGuard" g JOIN "ScanExecutionInvocationResolution" r ON r."guardId"=g.id
 JOIN "ScanSupervisorReceipt" receipt ON receipt.id=r."receiptId" AND receipt."operationId"=g."operationId" AND receipt."attemptId"=g."attemptId" AND receipt."commandId"=g."commandId" AND receipt."eventType"='prepare_invocation_completed'
 JOIN "ScanSupervisorJournalRecord" record ON record.id=receipt."journalRecordId"
 WHERE g."operationId"=$1 AND g."attemptId"=$2 AND g."workspaceId"=$3 AND g."authorityEpochId"=$4 AND g."commandId"=$5 AND g.phase='PREPARE' AND g."executorKey" IS NULL AND g."actionChecksum"=$6`,
      [
        command.attempt.operationId,
        command.attempt.attemptId,
        command.attempt.workspaceId,
        command.attempt.authorityEpochId,
        command.commandId,
        sha256Hex(canonicalJson(command)),
      ]
    )
  ).rows
  if (rows.length !== 1) unavailable()
  const row = z
    .object({
      id: z.string(),
      operationId: z.string(),
      attemptId: z.string(),
      authorityEpochId: z.string(),
      phase: z.literal("PREPARE"),
      commandId: z.string(),
      executorKey: z.null(),
      actionChecksum: z.string(),
      bindingInputJson: z.string(),
      proofInputJson: z.string(),
      proofChecksum: z.string(),
      receiptHash: z.string(),
      sequence: z.string(),
    })
    .parse(rows[0])
  const source = await readRetainedSupervisorAuthoritySource(connection, {
    operationId: command.attempt.operationId,
    attemptId: command.attempt.attemptId,
    commandId: command.commandId,
    authorityEpochId: command.attempt.authorityEpochId,
    supervisorInstanceId: authority.supervisorInstanceId,
    receiptHash: row.receiptHash,
  })
  const completed = await authenticateRetainedSupervisorAuthoritySource(
    source,
    authority,
    connection
  )
  if (
    completed.uncertain ||
    completed.original.sequence <= prepared.original.sequence ||
    canonicalJson(completed.original.payload) !== row.proofInputJson ||
    sha256Hex(row.proofInputJson) !== row.proofChecksum
  )
    unavailable()
  verifyPrepareInvocationCompleted(
    completed.original.payload,
    row,
    sha256Hex(canonicalJson(command))
  )
}
