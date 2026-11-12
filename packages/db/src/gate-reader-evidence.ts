import { isDeepStrictEqual } from "node:util"
import {
  computeGateVerdict,
  computeInputChecksum,
  computeVerdictChecksum,
  isTargetTypeCovered,
  requiredScannersForTarget,
  type GateApplicabilityResult,
  type GateEvidenceInput,
  type GateVerdictResult,
} from "@lyrashield/gate"
import { prepareGateFindingInputs, type loadGateFindings } from "./gate-retest-input"
import { loadReceiptBackedRetestFindingIdsAcrossTargets } from "./retest-evidence-trust"
import type { ScopedTransaction } from "./rls"
import type { VerifiedAssessedScan } from "./gate-assessed-scan-evidence"

const legacySummaryKeys = [
  "detected",
  "validated",
  "verified",
  "retestConfirmed",
  "inconclusive",
  "blockingUnverified",
]
const summaryShapes = [
  legacySummaryKeys,
  [...legacySummaryKeys, "unresolvedCritical", "unresolvedHigh"],
  [
    ...legacySummaryKeys,
    "unresolvedCritical",
    "unresolvedHigh",
    "unresolvedMedium",
    "unresolvedLow",
  ],
  [
    ...legacySummaryKeys,
    "unresolvedCritical",
    "unresolvedHigh",
    "unresolvedMedium",
    "unresolvedLow",
    "insufficientPositiveEvidence",
    "acceptedRisk",
    "falsePositive",
  ],
]
function validSummary(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return summaryShapes.some(
    (shape) =>
      shape.length === entries.length &&
      shape.every(
        (key) =>
          Object.hasOwn(value, key) &&
          Number.isSafeInteger((value as Record<string, unknown>)[key]) &&
          Number((value as Record<string, unknown>)[key]) >= 0
      )
  )
}
function validReasons(
  value: unknown
): value is { findingId: string; severity: string; verificationStatus: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (reason) =>
        reason &&
        typeof reason === "object" &&
        !Array.isArray(reason) &&
        typeof reason.findingId === "string" &&
        reason.findingId.length > 0 &&
        ["CRITICAL", "HIGH"].includes(reason.severity) &&
        ["DETECTED", "VALIDATED", "VERIFIED", "INCONCLUSIVE", "BLOCKED"].includes(
          reason.verificationStatus
        ) &&
        Object.keys(reason).length === 3
    )
  )
}

export type StoredGateEvidence = {
  state: string
  standardVersion: string
  coverageStatement: unknown
  nonCoverage: unknown
  blockingReasons: unknown
  evidenceSummary: unknown
  staleness: unknown
  inputChecksum: string
  verdictChecksum: string
}

/** Re-run the canonical gate on verified inputs and bind it to immutable history. */
export function matchesCurrentGateEvidence(
  row: StoredGateEvidence,
  input: GateEvidenceInput
): boolean {
  try {
    if (
      !Array.isArray(row.coverageStatement) ||
      !Array.isArray(row.nonCoverage) ||
      !validReasons(row.blockingReasons) ||
      !validSummary(row.evidenceSummary)
    )
      return false
    const current = computeGateVerdict(input)
    if (!isDeepStrictEqual(row.evidenceSummary, current.evidenceSummary)) return false
    const historical: GateVerdictResult = {
      standardVersion: row.standardVersion,
      state: row.state as GateVerdictResult["state"],
      coverageStatement: row.coverageStatement as GateVerdictResult["coverageStatement"],
      nonCoverage: row.nonCoverage as GateVerdictResult["nonCoverage"],
      blockingReasons: row.blockingReasons as GateVerdictResult["blockingReasons"],
      evidenceSummary: current.evidenceSummary,
      staleness: row.staleness as GateVerdictResult["staleness"],
    }
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical)
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonical(child)])
        )
      return value
    }
    const sorted = (items: unknown[]) =>
      [...items].sort((a, b) =>
        JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b)))
      )
    return (
      current.staleness.current &&
      row.standardVersion === current.standardVersion &&
      row.state === current.state &&
      row.inputChecksum === computeInputChecksum(input, row.standardVersion) &&
      row.verdictChecksum === computeVerdictChecksum(historical) &&
      isDeepStrictEqual(sorted(historical.coverageStatement), sorted(current.coverageStatement)) &&
      isDeepStrictEqual(sorted(historical.nonCoverage), sorted(current.nonCoverage)) &&
      isDeepStrictEqual(sorted(historical.blockingReasons), sorted(current.blockingReasons)) &&
      isDeepStrictEqual(historical.staleness, current.staleness)
    )
  } catch {
    return false
  }
}

/** Verify the finding-dependent parts of persisted verdicts without writing new history. */
export async function findMismatchedGateEvidence(
  tx: ScopedTransaction,
  workspaceId: string,
  verdicts: {
    targetId: string
    scanId: string | null
    evidenceSummary: unknown
    blockingReasons: unknown
  }[] &
    Partial<StoredGateEvidence>[],
  verifiedScans?: Map<string, VerifiedAssessedScan>
): Promise<Set<string>> {
  if (verdicts.length === 0) return new Set()
  type GateFinding = Awaited<ReturnType<typeof loadGateFindings>>["findings"][number] & {
    targetId: string
    hasPositiveReceipt: boolean
    retestEvidenceBytes: number
    targetEvidenceTooLarge: boolean
  }
  // At most one latest retest and one scoped positive-existence result per finding.
  const allFindings = await tx.$queryRaw<GateFinding[]>`
    WITH findings AS MATERIALIZED (
      SELECT f.*, retest."id" AS "retestId",
        COALESCE(retest."evidenceBytes", 0)::int AS "retestEvidenceBytes",
        EXISTS (SELECT 1 FROM "FindingVerification" v
          WHERE v."workspaceId" = ${workspaceId} AND v."findingId" = f."id"
            AND v."scanId" = requested."scanId" AND v."status" IN ('VALIDATED', 'VERIFIED')
            AND v."method" <> 'RETEST') AS "hasPositiveReceipt"
      FROM unnest(${verdicts.map((v) => v.targetId)}::text[], ${verdicts.map((v) => v.scanId)}::text[]) AS requested("targetId", "scanId")
      CROSS JOIN LATERAL (
        SELECT "id", "targetId", "severity"::text AS "severity", "status"::text AS "status",
          "verificationStatus"::text AS "verificationStatus", "lastSeenAt", "scanId", "dedupeKey",
          CASE WHEN "disposition" IN ('ACCEPTED_RISK', 'FALSE_POSITIVE') THEN "disposition" ELSE NULL END AS "disposition",
          CASE WHEN "dispositionActorUserId" IS NULL THEN NULL WHEN "dispositionActorUserId" = '' THEN '' ELSE 'present' END AS "dispositionActorUserId",
          CASE WHEN "dispositionReason" IS NULL THEN NULL WHEN "dispositionReason" = '' THEN '' ELSE 'present' END AS "dispositionReason",
          "dispositionAssessmentId", "dispositionAt", "canonicalFindingId"
        FROM "Finding"
        WHERE "workspaceId" = ${workspaceId} AND "targetId" = requested."targetId" AND "deletedAt" IS NULL
        ORDER BY "id" LIMIT 10001
      ) AS f
      LEFT JOIN LATERAL (
        SELECT "id", COALESCE(octet_length("evidence"::text), 0) + octet_length("scanId") AS "evidenceBytes"
        FROM "FindingVerification"
        WHERE "workspaceId" = ${workspaceId} AND "findingId" = f."id" AND "method" = 'RETEST'
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
      ) AS retest ON true
    ), budgets AS (
      SELECT "targetId", sum("retestEvidenceBytes" + octet_length("id") + octet_length("scanId") + octet_length("dedupeKey") +
        COALESCE(octet_length("canonicalFindingId"), 0) + COALESCE(octet_length("dispositionAssessmentId"), 0)) AS bytes
      FROM findings GROUP BY "targetId"
    )
    SELECT CASE WHEN budgets.bytes <= 4194304 THEN findings."id" ELSE '' END AS "id",
      findings."targetId", findings."severity", findings."status", findings."verificationStatus", findings."lastSeenAt",
      CASE WHEN budgets.bytes <= 4194304 THEN findings."scanId" ELSE '' END AS "scanId",
      CASE WHEN budgets.bytes <= 4194304 THEN findings."dedupeKey" ELSE '' END AS "dedupeKey",
      findings."disposition", findings."dispositionActorUserId", findings."dispositionReason",
      CASE WHEN budgets.bytes <= 4194304 THEN findings."dispositionAssessmentId" ELSE NULL END AS "dispositionAssessmentId",
      findings."dispositionAt", CASE WHEN budgets.bytes <= 4194304 THEN findings."canonicalFindingId" ELSE NULL END AS "canonicalFindingId",
      findings."retestEvidenceBytes", findings."hasPositiveReceipt", budgets.bytes > 4194304 AS "targetEvidenceTooLarge",
      CASE WHEN findings."retestId" IS NOT NULL AND findings."retestEvidenceBytes" <= 1048576 AND budgets.bytes <= 4194304
        THEN COALESCE((SELECT jsonb_build_array(jsonb_build_object(
          'status', v."status"::text, 'method', v."method"::text, 'scanId', v."scanId",
          'verifierVersion', CASE WHEN v."verifierVersion" = 'result-integrity-v3' THEN 'result-integrity-v3' ELSE NULL END,
          'evidence', v."evidence"
        )) FROM "FindingVerification" v WHERE v."workspaceId" = ${workspaceId} AND v."id" = findings."retestId"), '[]'::jsonb)
        ELSE '[]'::jsonb END AS "verificationReceipts"
    FROM findings JOIN budgets ON budgets."targetId" = findings."targetId"`
  const groups = new Map<string, typeof allFindings>()
  for (const finding of allFindings) {
    const group = groups.get(finding.targetId) ?? []
    group.push(finding)
    groups.set(finding.targetId, group)
  }
  const mismatches = new Set(
    [...groups]
      .filter(
        ([, group]) =>
          group.length > 10000 ||
          group.some(
            (finding) => finding.retestEvidenceBytes > 1048576 || finding.targetEvidenceTooLarge
          )
      )
      .map(([target]) => target)
  )
  const findings = allFindings.filter((finding) => !mismatches.has(finding.targetId))
  const trusted = await loadReceiptBackedRetestFindingIdsAcrossTargets(tx, {
    workspaceId,
    bounded: true,
    unverifiedTargetIds: mismatches,
    findings: findings
      .filter((finding) => finding.status === "FIXED")
      .map((finding) => ({
        ...finding,
        verificationReceipts: finding.verificationReceipts.filter(
          (receipt) => receipt.method === "RETEST"
        ),
      })),
  })
  for (const row of verdicts) {
    if (mismatches.has(row.targetId)) continue
    const group = groups.get(row.targetId) ?? []
    if (!validSummary(row.evidenceSummary) || !validReasons(row.blockingReasons)) {
      mismatches.add(row.targetId)
      continue
    }
    if (verifiedScans) {
      const scan = verifiedScans.get(row.targetId)
      if (
        !scan ||
        !row.standardVersion ||
        !row.state ||
        !row.inputChecksum ||
        !row.verdictChecksum
      ) {
        mismatches.add(row.targetId)
        continue
      }
      const evidence: GateEvidenceInput = {
        targetId: row.targetId,
        latestCompletedScan: {
          id: scan.scanId,
          endedAtMs: scan.endedAt.getTime(),
          status: "COMPLETED",
          mode: scan.mode,
        },
        coverageReceipts: scan.coverageReceipts.map((receipt) => ({
          controlId: receipt.controlId,
          scanner: receipt.scanner,
          status: receipt.status as GateEvidenceInput["coverageReceipts"][number]["status"],
          reason: receipt.reason ?? null,
        })),
        findings: prepareGateFindingInputs(
          group,
          trusted,
          row.scanId,
          new Set(
            group.filter((finding) => finding.hasPositiveReceipt).map((finding) => finding.id)
          )
        ),
        requiredScanners: isTargetTypeCovered(scan.targetType)
          ? requiredScannersForTarget(scan.targetType, scan.mode)
          : [],
        targetTypeCovered: isTargetTypeCovered(scan.targetType),
        policyFingerprint: scan.policyFingerprint,
        assessmentIdentityComplete: true,
      }
      if (!matchesCurrentGateEvidence(row as StoredGateEvidence, evidence))
        mismatches.add(row.targetId)
      continue
    }
    if (
      group.length === 0 &&
      Object.values(row.evidenceSummary).every((value) => value === 0) &&
      row.blockingReasons.length === 0
    )
      continue
    const computed = computeGateVerdict({
      targetId: row.targetId,
      latestCompletedScan: null,
      coverageReceipts: [],
      findings: prepareGateFindingInputs(
        group,
        trusted,
        row.scanId,
        new Set(group.filter((finding) => finding.hasPositiveReceipt).map((finding) => finding.id))
      ),
      requiredScanners: [],
      targetTypeCovered: false,
    })
    const sortReasons = (value: unknown) =>
      Array.isArray(value)
        ? [...value].sort((a, b) => String(a.findingId).localeCompare(String(b.findingId)))
        : value
    if (
      !isDeepStrictEqual(computed.evidenceSummary, row.evidenceSummary) ||
      !isDeepStrictEqual(sortReasons(computed.blockingReasons), sortReasons(row.blockingReasons))
    ) {
      mismatches.add(row.targetId)
    }
  }
  return mismatches
}

/** Keep the historical verdict intact while preventing its enforcement. */
export function invalidateUntrustedGateEvidence(
  result: GateApplicabilityResult
): GateApplicabilityResult {
  return {
    ...result,
    applicable: false,
    effectiveState: "INSUFFICIENT_EVIDENCE",
    reasons: [
      ...result.reasons,
      {
        code: "UNTRUSTED_GATE_EVIDENCE",
        message:
          "The stored verdict could not be confirmed against its assessment, coverage, or finding evidence; run a new assessment.",
      },
    ],
  }
}
