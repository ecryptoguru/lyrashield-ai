import type { GateVerdict } from "./generated/prisma"
import type { ScopedTransaction } from "./rls"

// A transport bound, not a producer guarantee. Oversized historical evidence is
// retained in the database but cannot be presented as a current verdict.
export const MAX_GATE_VERDICT_BYTES = 4 * 1024 * 1024
export const MAX_GATE_READ_BATCH_TARGETS = 5

export type BoundedGateVerdict = GateVerdict & { evidenceTooLarge: boolean }

/** Load selected rows with their JSON and text fields bounded before transport. */
export async function loadBoundedGateVerdicts(
  tx: ScopedTransaction,
  workspaceId: string,
  options: { targetIds?: string[]; verdictId?: string; requireActiveTarget?: boolean }
): Promise<BoundedGateVerdict[]> {
  const targetIds = options.targetIds ?? []
  if (targetIds.length > MAX_GATE_READ_BATCH_TARGETS)
    throw new Error("Gate read target page exceeds the supported limit")
  if (!options.verdictId && targetIds.length === 0) return []
  const verdictId = options.verdictId ?? null
  return tx.$queryRaw<BoundedGateVerdict[]>`
    WITH selected AS MATERIALIZED (
      SELECT DISTINCT ON ("targetId") "id", "targetId"
      FROM "GateVerdict"
      WHERE "workspaceId" = ${workspaceId}
        AND ("id" = ${verdictId}::text OR (${verdictId}::text IS NULL AND "targetId" = ANY(${targetIds}::text[])))
      ORDER BY "targetId", "evaluatedAt" DESC, "id" DESC
    ), bytes AS MATERIALIZED (
      SELECT v."id", COALESCE(octet_length(v."scanId"), 0) + octet_length(v."standardVersion") + octet_length(v."state") +
        octet_length(v."inputChecksum") + octet_length(v."verdictChecksum") +
        COALESCE(octet_length(v."coverageStatement"::text), 0) + COALESCE(octet_length(v."nonCoverage"::text), 0) +
        COALESCE(octet_length(v."blockingReasons"::text), 0) + COALESCE(octet_length(v."evidenceSummary"::text), 0) +
        COALESCE(octet_length(v."staleness"::text), 0) + COALESCE(octet_length(v."assessmentSnapshot"::text), 0) AS total
      FROM selected
      JOIN "GateVerdict" v ON v."id" = selected."id" AND v."workspaceId" = ${workspaceId}
      WHERE (NOT ${options.requireActiveTarget ?? false}::boolean OR EXISTS (
        SELECT 1 FROM "Target" t WHERE t."id" = v."targetId" AND t."workspaceId" = ${workspaceId} AND t."deletedAt" IS NULL
      ))
    )
    SELECT v."id", v."workspaceId", v."targetId", v."evaluatedAt", v."assessmentVersion",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."scanId" ELSE NULL END AS "scanId",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."standardVersion" ELSE '' END AS "standardVersion",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."state"
        WHEN v."state" IN ('READY', 'NOT_READY', 'INSUFFICIENT_EVIDENCE') THEN v."state"
        ELSE 'INSUFFICIENT_EVIDENCE' END AS "state",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."coverageStatement" ELSE NULL END AS "coverageStatement",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."nonCoverage" ELSE NULL END AS "nonCoverage",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."blockingReasons" ELSE NULL END AS "blockingReasons",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."evidenceSummary" ELSE NULL END AS "evidenceSummary",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."staleness" ELSE NULL END AS "staleness",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."assessmentSnapshot" ELSE NULL END AS "assessmentSnapshot",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."inputChecksum" ELSE '' END AS "inputChecksum",
      CASE WHEN bytes.total <= ${MAX_GATE_VERDICT_BYTES} THEN v."verdictChecksum" ELSE '' END AS "verdictChecksum",
      bytes.total > ${MAX_GATE_VERDICT_BYTES} AS "evidenceTooLarge"
    FROM bytes
    JOIN "GateVerdict" v ON v."id" = bytes."id" AND v."workspaceId" = ${workspaceId}
    ORDER BY v."targetId"`
}
