import { z } from "zod"
import {
  authorityActionSchema,
  canonicalJson,
  sha256Hex,
  supervisorCommandSchema,
  type AuthorityAction,
  type AuthoritySqlConnection,
  type PrepareCommand,
} from "@lyrashield/runtime-control"
import { readStoredDispatchCommand } from "./scan-dispatch-command-descriptor"

export const currentPrepareInputSchema = z
  .object({ command: supervisorCommandSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .refine((input) => input.command.type === "PREPARE")
export type CurrentPersistedPrepare = Readonly<{
  command: PrepareCommand
  binding: AuthorityAction
  requestHash: string
  deadlineAt: Date
}>
function unavailable(): never {
  throw new Error("Current persisted preparation command is unavailable")
}
export function deriveCurrentPrepareBinding(
  command: PrepareCommand,
  requestHash: string
): AuthorityAction {
  if (sha256Hex(canonicalJson(command)) !== requestHash) unavailable()
  return authorityActionSchema.parse({
    phase: "PREPARE",
    commandId: command.commandId,
    operationId: command.attempt.operationId,
    attemptId: command.attempt.attemptId,
    scanId: command.attempt.scanId,
    workspaceId: command.attempt.workspaceId,
    authorityEpochId: command.attempt.authorityEpochId,
    authorityRevision: command.attempt.authorityRevision,
    authorityChecksum: sha256Hex(
      canonicalJson({
        attempt: command.attempt,
        executors: command.executors,
        provider: command.provider ?? null,
      })
    ),
    actionChecksum: requestHash,
  })
}
function freezePrepareValue(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezePrepareValue(child)
    Object.freeze(value)
  }
}
/** Positive current outbox authority; absence of historical receipts never grants permission.
 * The installed reader owns the native session gate, connection and independent pin scope. */
export async function withCurrentPersistedPrepare<T>(
  connection: AuthoritySqlConnection,
  input: unknown,
  callback: (verified: CurrentPersistedPrepare, assertActive: () => Promise<void>) => Promise<T>
): Promise<T> {
  const parsed = currentPrepareInputSchema.parse(input)
  if (parsed.command.type !== "PREPARE") unavailable()
  freezePrepareValue(parsed.command)
  const command = parsed.command,
    binding = deriveCurrentPrepareBinding(command, parsed.requestHash)
  const { bindScanExecutionAuthorityContext, createScanExecutionActionAuthorityVerifier } =
    await import("./scan-execution-action-intent")
  const verifyCurrent = createScanExecutionActionAuthorityVerifier({
    approvedProviderPolicies: new Map(),
  })
  let active = true
  const assertActive = async () => {
    if (!active) unavailable()
    if (
      (await connection.query("SELECT app.scan_preparation_gate_held() AS held", [])).rows[0]
        ?.held !== true
    )
      unavailable()
    await bindScanExecutionAuthorityContext(connection, command.attempt.operationId)
    const rows = (
      await connection.query(
        `SELECT c."commandInputJson",c."commandInputChecksum" FROM "ScanDispatchOutbox" c
   JOIN "ScanDispatchAttempt" a ON a."operationId"=c."operationId" AND a."attemptId"=c."attemptId"
   WHERE c.id=$1 AND c."operationId"=$2 AND c."attemptId"=$3 AND a."workspaceId"=app.current_workspace_id() AND a."authorityEpochId"=$4
    AND c."commandType"='PREPARE' AND c.status IN ('PENDING','LEASED') AND c."commandInputChecksum"=$5
    AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationGuard" g WHERE g."operationId"=c."operationId" AND g."attemptId"=c."attemptId" AND g."commandId"=c.id)
    AND NOT EXISTS(SELECT 1 FROM "ScanSupervisorReceipt" r WHERE r."operationId"=c."operationId" AND r."attemptId"=c."attemptId" AND r."commandId"=c.id)
   `,
        [
          command.commandId,
          command.attempt.operationId,
          command.attempt.attemptId,
          command.attempt.authorityEpochId,
          parsed.requestHash,
        ]
      )
    ).rows
    if (rows.length !== 1) unavailable()
    const row = z
      .object({ commandInputJson: z.string(), commandInputChecksum: z.string() })
      .parse(rows[0])
    const retained = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
    if (!retained || retained.type !== "PREPARE" || row.commandInputJson !== canonicalJson(command))
      unavailable()
    const verified = await verifyCurrent(connection, binding)
    if (
      !verified ||
      !(verified.deadlineAt instanceof Date) ||
      verified.deadlineAt.getTime() <= Date.now()
    )
      unavailable()
    return verified.deadlineAt
  }
  try {
    const deadlineAt = await assertActive()
    const result = await callback(
      Object.freeze({ command, binding, requestHash: parsed.requestHash, deadlineAt }),
      async () => {
        await assertActive()
      }
    )
    await assertActive()
    return result
  } finally {
    active = false
  }
}
