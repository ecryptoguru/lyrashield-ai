import { createHash } from "node:crypto"
import { ScanJobDataSchema } from "@lyrashield/types"
import { z } from "zod"
import type { Scan } from "./generated/prisma"
import type { ScanAdmissionOptions, ScanTransaction } from "./scan-service-types"

const admissionOptionsSchema = z
  .object({ dispatchAuthority: z.literal("shadow").optional() })
  .strict()
const scopeDigestSchema = z
  .array(z.object({ requestDigest: z.string().regex(/^[a-f0-9]{64}$/) }))
  .length(1)

export function parseScanAdmissionOptions(options?: ScanAdmissionOptions): ScanAdmissionOptions {
  return admissionOptionsSchema.parse(options ?? {})
}

/**
 * Called only inside createScan's admission transaction, after the immutable
 * plan, delegated provenance, sponsor-scoped reservation and queued event.
 * No grants or epochs are opened here. UNKNOWN is sticky in both existing SQL
 * state machines: these qualification records cannot be prepared or leased,
 * even after a later epoch opens. Current callers retain the legacy queue path.
 */
export async function persistShadowScanDispatchAdmission(tx: ScanTransaction, scan: Scan) {
  const scope = scopeDigestSchema.parse(
    await tx.$queryRaw`
      SELECT app.scan_dispatch_scope_digest(${scan.id}) AS "requestDigest"
      FROM "Scan" WHERE id = ${scan.id} AND "workspaceId" = ${scan.workspaceId}
        AND "deletedAt" IS NULL
    `
  )[0]!
  // Reconstruct baseline transport fields from the persisted scan, never from
  // delegated operation IDs or a caller-provided queue payload. Optional legacy
  // focus is not dispatch authority; this shadow outbox is never published.
  const payload = ScanJobDataSchema.parse({
    scanId: scan.id,
    workspaceId: scan.workspaceId,
    targetId: scan.targetId,
    goal: scan.goal,
    mode: scan.mode,
    ...(scan.policyId ? { policyId: scan.policyId } : {}),
  })
  const operation = await tx.scanDispatchOperation.create({
    data: {
      scanId: scan.id,
      workspaceId: scan.workspaceId,
      protocolVersion: 3,
      requestDigest: scope.requestDigest,
      state: "QUEUED",
    },
  })
  // The insert guard requires QUEUED. Quarantine before this transaction can
  // commit; there is no externally visible actionable intermediate state.
  await tx.scanDispatchOperation.update({
    where: { operationId: operation.operationId, scanId: scan.id, workspaceId: scan.workspaceId },
    data: { state: "UNKNOWN" },
  })
  await tx.scanQueueOutbox.create({
    data: {
      scanId: scan.id,
      operationId: operation.operationId,
      jobId: scan.id,
      payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      state: "UNKNOWN",
      lastErrorCode: "SHADOW_ADMISSION_CLOSED",
    },
  })
}
