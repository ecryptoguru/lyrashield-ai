import { canonicalJson, sha256Hex } from "@lyrashield/runtime-control"
import { withWorkspaceRLS } from "./rls"

/** Runtime accounting reads this committed proof after the receipt consumer releases its native gate. */
export async function readScanDispatchCleanupProof(workspaceId: string, scanId: string) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        operationId: string
        attemptId: string
        authorityEpochId: string
        physicalState: string
        supervisorReceiptId: string
        releaseDigest: string
        paid: boolean
      }>
    >`SELECT release."operationId",release."attemptId",release."authorityEpochId",release."physicalState"::text,
      release."supervisorReceiptId",release."releaseDigest",
      EXISTS(SELECT 1 FROM "ScanDispatchOutbox" paid WHERE paid."operationId"=operation."operationId" AND paid."commandType"='START_PAID') AS paid
      FROM "ScanDispatchReleaseReceipt" release JOIN "ScanDispatchOperation" operation ON operation."operationId"=release."operationId"
      JOIN "ScanPhysicalExecution" physical ON physical."operationId"=release."operationId" AND physical."attemptId"=release."attemptId"
      JOIN "ScanSupervisorReceipt" receipt ON receipt.id=release."supervisorReceiptId" AND receipt."operationId"=release."operationId" AND receipt."attemptId"=release."attemptId"
      WHERE operation."workspaceId"=${workspaceId} AND operation."scanId"=${scanId}
        AND physical.state=release."physicalState" AND physical."lastReceiptId"=receipt.id
        AND receipt."eventType"='command_terminal' AND receipt."journalRecordId" IS NOT NULL AND receipt."terminalStatus"=release."physicalState"::text
        AND NOT EXISTS(SELECT 1 FROM "ScanDispatchOutbox" unresolved WHERE unresolved."operationId"=operation."operationId" AND unresolved.status NOT IN ('COMPLETED','REJECTED'))`
    if (rows.length !== 1) return null
    const row = rows[0]!
    const body = {
      schema: "lyrashield-dispatch-release/1",
      operationId: row.operationId,
      attemptId: row.attemptId,
      authorityEpochId: row.authorityEpochId,
      physicalState: row.physicalState,
      supervisorReceiptId: row.supervisorReceiptId,
    }
    if (
      !["STOPPED", "NEVER_DISPATCHED"].includes(row.physicalState) ||
      sha256Hex(canonicalJson(body)) !== row.releaseDigest
    )
      return null
    return {
      ...body,
      noBillableWork: !row.paid,
      billingDisposition: row.paid ? ("settlement_required" as const) : ("nonbillable" as const),
    }
  })
}
