import { isDeepStrictEqual } from "node:util"
import { VIBE_SECURITY_CONTROLS } from "@lyrashield/security"
import { parseAssessmentSnapshot, snapshotFromManifest } from "./gate-assessment"
import { isVerifiedPacketScan } from "./release-packet-evidence"
import type { ScopedTransaction } from "./rls"

// Current producer: 500 scoped entries + 50 gaps + 9 families + one row per
// control + one PHP applicability receipt. Oversized evidence is unavailable.
const MAX_COVERAGE_ROWS = 500 + 50 + 9 + 1 + VIBE_SECURITY_CONTROLS.length
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024

type Target = { id: string; workspaceId: string; type: string; deletedAt: Date | null }
type Scan = Omit<Parameters<typeof isVerifiedPacketScan>[0], "resultManifest"> & {
  workspaceId: string
  targetId: string | null
  deletedAt: Date | null
  status: string
  endedAt: Date | null
  policyId: string | null
  resultManifest:
    | (NonNullable<Parameters<typeof isVerifiedPacketScan>[0]["resultManifest"]> & {
        version: number
      })
    | null
}

export interface VerifiedAssessedScan {
  targetType: string
  scanId: string
  mode: string
  endedAt: Date
  policyFingerprint: string
  coverageReceipts: Scan["coverageReceipts"]
}

/** A historical assessment is usable only while its exact scan evidence remains verifiable. */
export function isVerifiedAssessedScan(input: {
  workspaceId: string
  verdict: { targetId: string; scanId: string | null; assessmentSnapshot: unknown }
  target: Target | null
  scan: Scan | null
  overflow: boolean
}): boolean {
  const { workspaceId, verdict, target, scan, overflow } = input
  const snapshot = parseAssessmentSnapshot(verdict.assessmentSnapshot)
  if (
    overflow ||
    !snapshot ||
    !target ||
    !scan ||
    target.workspaceId !== workspaceId ||
    target.id !== verdict.targetId ||
    target.deletedAt !== null ||
    scan.workspaceId !== workspaceId ||
    scan.targetId !== target.id ||
    scan.deletedAt !== null ||
    scan.status !== "COMPLETED" ||
    scan.coverageReceipts.length > MAX_COVERAGE_ROWS ||
    verdict.scanId !== snapshot.scanId ||
    scan.id !== snapshot.scanId ||
    !isVerifiedPacketScan(scan, snapshot, target)
  )
    return false

  const derived = snapshotFromManifest({
    scanId: scan.id,
    endedAt: scan.endedAt,
    policyId: scan.policyId,
    policyFingerprint: snapshot.policyFingerprint,
    manifest: scan.resultManifest,
  })
  return Boolean(
    derived &&
    Object.entries(derived).every(([key, value]) =>
      isDeepStrictEqual(value, snapshot[key as keyof typeof snapshot])
    )
  )
}

/**
 * One set-based read inside the caller's RLS transaction. Callers must bound the
 * number of verdicts separately; per-scan bounds do not bound the whole batch.
 */
export async function loadVerifiedAssessedScans(
  tx: ScopedTransaction,
  workspaceId: string,
  verdicts: { targetId: string; scanId: string | null; assessmentSnapshot: unknown }[]
): Promise<{ unverified: Set<string>; verified: Map<string, VerifiedAssessedScan> }> {
  const unverified = new Set<string>()
  const verified = new Map<string, VerifiedAssessedScan>()
  const requested = verdicts.flatMap((verdict) => {
    const snapshot = parseAssessmentSnapshot(verdict.assessmentSnapshot)
    if (!snapshot || verdict.scanId !== snapshot.scanId) {
      unverified.add(verdict.targetId)
      return []
    }
    return [{ verdict, snapshot }]
  })
  if (requested.length === 0) return { unverified, verified }

  const rows = await tx.$queryRaw<
    {
      requestedTargetId: string
      targetId: string | null
      targetWorkspaceId: string | null
      targetType: string | null
      scanId: string | null
      scanWorkspaceId: string | null
      scanTargetId: string | null
      status: string | null
      mode: string | null
      endedAt: Date | null
      policyId: string | null
      resultManifest: Scan["resultManifest"]
      coverageReceipts: Scan["coverageReceipts"] | null
      overflow: boolean
    }[]
  >`
    SELECT requested."targetId" AS "requestedTargetId",
      t."id" AS "targetId", t."workspaceId" AS "targetWorkspaceId", t."type"::text AS "targetType",
      s."id" AS "scanId", s."workspaceId" AS "scanWorkspaceId", s."targetId" AS "scanTargetId",
      s."status"::text AS "status", s."mode"::text AS "mode", s."endedAt", s."policyId",
      CASE WHEN m."scanId" IS NOT NULL AND
        octet_length(m."checksumInput") <= ${MAX_EVIDENCE_BYTES} AND
        octet_length(m."manifest"::text) <= ${MAX_EVIDENCE_BYTES}
        THEN jsonb_build_object('version', m."version", 'checksum', m."checksum",
          'checksumInput', m."checksumInput", 'manifest', m."manifest")
        ELSE NULL END AS "resultManifest",
      coverage.items AS "coverageReceipts",
      COALESCE(coverage.overflow, false) AS "overflow"
    FROM unnest(${requested.map(({ verdict }) => verdict.targetId)}::text[],
      ${requested.map(({ snapshot }) => snapshot.scanId)}::text[]) AS requested("targetId", "scanId")
    LEFT JOIN "Target" t ON t."id" = requested."targetId" AND t."workspaceId" = ${workspaceId} AND t."deletedAt" IS NULL
    LEFT JOIN "Scan" s ON s."id" = requested."scanId" AND s."workspaceId" = ${workspaceId}
      AND s."targetId" = t."id" AND s."deletedAt" IS NULL AND s."status" = 'COMPLETED'
    LEFT JOIN "ScanResultManifest" m ON m."scanId" = s."id"
    LEFT JOIN LATERAL (
      WITH bounded AS MATERIALIZED (
        SELECT "id", octet_length(jsonb_build_object(
          'scanner', "scanner", 'controlId', "controlId", 'status', "status"::text,
          'reason', "reason", 'subject', "subject", 'metadata', "metadata"
        )::text) AS bytes
        FROM "ScanCoverageReceipt" WHERE "scanId" = s."id" LIMIT ${MAX_COVERAGE_ROWS + 1}
      ), stats AS (
        SELECT count(*) AS count, COALESCE(sum(bounded.bytes), 0) AS bytes
        FROM bounded
      )
      SELECT stats.count > ${MAX_COVERAGE_ROWS} OR stats.bytes > ${MAX_EVIDENCE_BYTES} AS overflow,
        CASE WHEN stats.count <= ${MAX_COVERAGE_ROWS} AND stats.bytes <= ${MAX_EVIDENCE_BYTES}
          THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'scanner', c."scanner", 'controlId', c."controlId", 'status', c."status"::text,
            'reason', c."reason", 'subject', c."subject", 'metadata', c."metadata"
          )), '[]'::jsonb) FROM "ScanCoverageReceipt" c JOIN bounded ids ON ids."id" = c."id" WHERE c."scanId" = s."id")
          ELSE NULL END AS items
      FROM stats
    ) coverage ON true`

  const rowsByTarget = new Map(rows.map((row) => [row.requestedTargetId, row]))
  for (const { verdict } of requested) {
    const row = rowsByTarget.get(verdict.targetId)
    if (!row) {
      unverified.add(verdict.targetId)
      continue
    }
    const target =
      row.targetId && row.targetWorkspaceId && row.targetType
        ? {
            id: row.targetId,
            workspaceId: row.targetWorkspaceId,
            type: row.targetType,
            deletedAt: null,
          }
        : null
    const scan =
      row.scanId && row.scanWorkspaceId && row.scanTargetId && row.status && row.coverageReceipts
        ? {
            id: row.scanId,
            workspaceId: row.scanWorkspaceId,
            targetId: row.scanTargetId,
            status: row.status,
            deletedAt: null,
            endedAt: row.endedAt,
            policyId: row.policyId,
            resultManifest: row.resultManifest,
            coverageReceipts: row.coverageReceipts,
          }
        : null
    if (
      !isVerifiedAssessedScan({ workspaceId, verdict, target, scan, overflow: row.overflow }) ||
      !target ||
      !scan ||
      !row.mode ||
      !scan.endedAt
    ) {
      unverified.add(verdict.targetId)
    } else {
      verified.set(verdict.targetId, {
        targetType: target.type,
        scanId: scan.id,
        mode: row.mode,
        endedAt: scan.endedAt,
        policyFingerprint: parseAssessmentSnapshot(verdict.assessmentSnapshot)!.policyFingerprint,
        coverageReceipts: scan.coverageReceipts,
      })
    }
  }
  return { unverified, verified }
}

export async function findUnverifiedAssessedScans(
  tx: ScopedTransaction,
  workspaceId: string,
  verdicts: { targetId: string; scanId: string | null; assessmentSnapshot: unknown }[]
): Promise<Set<string>> {
  return (await loadVerifiedAssessedScans(tx, workspaceId, verdicts)).unverified
}
