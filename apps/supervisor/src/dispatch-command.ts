import { z } from "zod"
import type pg from "pg"
import { canonicalJson, type SupervisorCommand } from "@lyrashield/runtime-control"
import { bindScanExecutionAuthorityContext } from "@lyrashield/db/src/scan-execution-action-intent"
import {
  requireScanDispatchWorkerAssignment,
  requireScanDispatchWorkerCleanup,
} from "@lyrashield/db/src/scan-dispatch-worker-assignment"
import { readStoredDispatchCommand } from "@lyrashield/db/src/scan-dispatch-command-descriptor"
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/)
export const installedDispatchCommandInputSchema = z
  .object({ operationId: id, commandId: id })
  .strict()
/** Selects immutable server-owned bytes. The existing supervisor execute path owns all positive effect checks. */
export function createInstalledDispatchCommandReader(
  pool: Pick<pg.Pool, "connect">,
  epochId: string
) {
  return async (value: unknown): Promise<SupervisorCommand> => {
    const input = installedDispatchCommandInputSchema.parse(value),
      client = await pool.connect()
    try {
      await client.query("BEGIN READ ONLY")
      await client.query("SET LOCAL statement_timeout='5s'")
      await client.query("SELECT app.require_scan_execution_action_role()")
      const gate = await client.query<{ held: boolean }>(
        "SELECT pg_try_advisory_xact_lock(1819234670,1) AS held"
      )
      if (gate.rows[0]?.held !== true) throw new Error("Command source authority is busy")
      await bindScanExecutionAuthorityContext(client, input.operationId)
      const rows = await client.query<{
        commandInputJson: string
        commandInputChecksum: string
        commandType: string
        attemptId: string
        scanId: string
        workspaceId: string
        authorityEpochId: string
      }>(
        `SELECT c."commandInputJson",c."commandInputChecksum",c."commandType"::text,a."attemptId",a."scanId",a."workspaceId",a."authorityEpochId"
    FROM "ScanDispatchOutbox" c JOIN "ScanDispatchAttempt" a ON a."operationId"=c."operationId" AND a."attemptId"=c."attemptId"
    WHERE c.id=$1 AND c."operationId"=$2 AND a."workspaceId"=app.current_workspace_id() AND a."authorityEpochId"=$3
      AND c.status IN ('PENDING','LEASED','ACCEPTED','COMPLETED')`,
        [input.commandId, input.operationId, epochId]
      )
      if (rows.rows.length !== 1) throw new Error("Persisted command source unavailable")
      const row = rows.rows[0]!,
        command = readStoredDispatchCommand(row.commandInputJson, row.commandInputChecksum)
      if (
        !command ||
        command.commandId !== input.commandId ||
        command.type !== row.commandType ||
        row.commandInputJson !== canonicalJson(command) ||
        (command.type === "PREPARE"
          ? command.attempt.operationId !== input.operationId ||
            command.attempt.attemptId !== row.attemptId ||
            command.attempt.scanId !== row.scanId ||
            command.attempt.workspaceId !== row.workspaceId ||
            command.attempt.authorityEpochId !== row.authorityEpochId
          : command.attemptId !== row.attemptId)
      )
        throw new Error("Persisted command source mismatch")
      if (command.type === "STOP" || command.type === "RECONCILE")
        await requireScanDispatchWorkerCleanup(client, input.operationId)
      else await requireScanDispatchWorkerAssignment(client, input.operationId)
      await client.query("COMMIT")
      return command
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}
