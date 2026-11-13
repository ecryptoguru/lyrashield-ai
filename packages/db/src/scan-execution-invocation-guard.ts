import { createId } from "@paralleldrive/cuid2"
import {
  authorityActionSchema,
  canonicalJson,
  type AuthorityAction,
  type AuthoritySqlConnection,
  type VerifyActionAuthority,
} from "@lyrashield/runtime-control"

import { bindScanExecutionAuthorityContext } from "./scan-execution-action-intent"

function unavailable(): never {
  throw new Error("Original execution invocation guard is unavailable")
}

export interface ScanExecutionInvocationGuardWriter {
  /** Caller holds native SESSION gate and an authorization transaction. */
  begin(connection: AuthoritySqlConnection, binding: AuthorityAction): Promise<{ guardId: string }>
  /** After confirmed COMMIT, check the same SESSION gate and exact persisted guard. */
  verifyCommitted(
    connection: AuthoritySqlConnection,
    binding: AuthorityAction,
    guardId: string
  ): Promise<void>
}

/** No resolution/expiry method: authenticated original observer evidence owns release. */
export function createScanExecutionInvocationGuardWriter(
  verify: VerifyActionAuthority
): ScanExecutionInvocationGuardWriter {
  return {
    async begin(connection, input) {
      const binding = authorityActionSchema.parse(input)
      await verify(connection, binding)
      const existing = (
        await connection.query(
          `SELECT id FROM "ScanExecutionInvocationGuard" WHERE "operationId"=$1 AND phase=$2 AND "actionChecksum"=$3`,
          [binding.operationId, binding.phase, binding.actionChecksum]
        )
      ).rows[0]
      // Lost invocation/ACK is reconciled under its original guard, never replayed.
      if (existing) unavailable()
      const guardId = createId()
      await connection.query(
        `INSERT INTO "ScanExecutionInvocationGuard"(id,"operationId","attemptId","scanId","workspaceId","authorityEpochId",phase,"commandId","requestId","executorKey","authorityChecksum","actionChecksum","bindingInputJson")
         VALUES($1,$2,$3,$4,$5,$6,$7,nullif($8,''),nullif($9,''),nullif($10,''),$11,$12,$13)`,
        [
          guardId,
          binding.operationId,
          binding.attemptId,
          binding.scanId,
          binding.workspaceId,
          binding.authorityEpochId,
          binding.phase,
          binding.commandId ?? "",
          binding.requestId ?? "",
          binding.executorKey ?? "",
          binding.authorityChecksum,
          binding.actionChecksum,
          canonicalJson(binding),
        ]
      )
      return { guardId }
    },
    async verifyCommitted(connection, input, guardId) {
      const binding = authorityActionSchema.parse(input)
      await bindScanExecutionAuthorityContext(connection, binding.operationId)
      const row = (
        await connection.query(
          `SELECT g."bindingInputJson" FROM "ScanExecutionInvocationGuard" g WHERE g.id=$1 AND g."operationId"=$2 AND g."attemptId"=$3 AND g."workspaceId"=$4
          AND app.scan_preparation_gate_held() AND NOT EXISTS(SELECT 1 FROM "ScanExecutionInvocationResolution" r WHERE r."guardId"=g.id)`,
          [guardId, binding.operationId, binding.attemptId, binding.workspaceId]
        )
      ).rows[0]
      if (row?.bindingInputJson !== canonicalJson(binding)) unavailable()
    },
  }
}
