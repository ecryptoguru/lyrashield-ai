import pg from "pg"
import { createPgConnectionConfig } from "./connection-config"
import { requireScanDispatchWorkerAssignment } from "./scan-dispatch-worker-assignment"
import { readPublishedScanQueueAuthority } from "./scan-queue-outbox-store"
import { createScanQueuePublicationProof } from "./scan-queue-publication-proof"
import {
  queuePublicationVerificationInputSchema,
  queuePublicationVerificationResultSchema,
  type QueuePublicationVerificationResult,
} from "./scan-queue-publication-verifier-schema"

/** Restricted broker role performs a scoped read; never publisher writes or quarantine. */
export function createScanQueuePublicationVerifier(connectionString: string) {
  const pool = new pg.Pool({
    ...createPgConnectionConfig(connectionString),
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    idleTimeoutMillis: 10000,
  })
  pool.on("error", () => undefined)
  return {
    async verifyDispatch(value: unknown): Promise<QueuePublicationVerificationResult> {
      const input = queuePublicationVerificationInputSchema.parse(value)
      const client = await pool.connect()
      let failed = true
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
        await client.query(
          "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='10s'"
        )
        await client.query("SELECT app.require_scan_preparation_role()")
        await client.query("SELECT set_config('app.current_workspace_id',$1,true)", [
          input.workspaceId,
        ])
        await requireScanDispatchWorkerAssignment(client, input.operationId)
        const row = await readPublishedScanQueueAuthority(client, {
          operationId: input.operationId,
          workspaceId: input.workspaceId,
        })
        if (!row) return { kind: "closed" }
        createScanQueuePublicationProof(row, row.payloadInputJson!, input.snapshot)
        await requireScanDispatchWorkerAssignment(client, input.operationId)
        const result = queuePublicationVerificationResultSchema.parse({
          kind: "published",
          row: {
            operationId: row.operationId,
            id: row.id,
            workspaceId: row.workspaceId,
            executionPlanHash: row.executionPlanHash,
            requestDigest: row.requestDigest,
            payloadInputJson: row.payloadInputJson,
          },
        })
        await client.query("ROLLBACK")
        failed = false
        return result
      } catch (error) {
        if ((error as { code?: string })?.code === "WORKER_GRANT_INVALID") throw error
        return { kind: "closed" }
      } finally {
        if (failed) await client.query("ROLLBACK").catch(() => undefined)
        client.release(failed)
      }
    },
    close: () => pool.end(),
  }
}
