import { isDeepStrictEqual } from "node:util"
import { computeGateVerdict, type GateApplicabilityResult } from "@lyrashield/gate"
import { prepareGateFindingInputs, type loadGateFindings } from "./gate-retest-input"
import { loadReceiptBackedRetestFindingIdsAcrossTargets } from "./retest-evidence-trust"
import type { ScopedTransaction } from "./rls"

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

/** Verify the finding-dependent parts of persisted verdicts without writing new history. */
export async function findMismatchedGateEvidence(
  tx: ScopedTransaction,
  workspaceId: string,
  verdicts: {
    targetId: string
    scanId: string | null
    evidenceSummary: unknown
    blockingReasons: unknown
  }[]
): Promise<Set<string>> {
  if (verdicts.length === 0) return new Set()
  type GateFinding = Awaited<ReturnType<typeof loadGateFindings>>["findings"][number] & {
    targetId: string
  }
  // The database returns at most 10,001 rows per requested target and at most
  // 101 receipts per finding; excess is detected per target, never globally.
  const allFindings = await tx.$queryRaw<GateFinding[]>`
    SELECT f.*, COALESCE(receipts.items, '[]'::jsonb) AS "verificationReceipts"
    FROM unnest(${verdicts.map((v) => v.targetId)}::text[]) AS requested("targetId")
    CROSS JOIN LATERAL (
      SELECT "id", "targetId", "severity"::text AS "severity", "status"::text AS "status",
        "verificationStatus"::text AS "verificationStatus", "lastSeenAt", "scanId", "dedupeKey",
        "disposition", "dispositionActorUserId", "dispositionReason", "dispositionAssessmentId",
        "dispositionAt", "canonicalFindingId"
      FROM "Finding"
      WHERE "workspaceId" = ${workspaceId} AND "targetId" = requested."targetId" AND "deletedAt" IS NULL
      ORDER BY "id" LIMIT 10001
    ) AS f
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'status', r."status", 'method', r."method", 'scanId', r."scanId",
        'verifierVersion', r."verifierVersion", 'evidence', r."evidence"
      ) ORDER BY r."createdAt" DESC, r."id" DESC) AS items FROM (
        SELECT "id", "createdAt", "status"::text AS "status", "method"::text AS "method", "scanId", "verifierVersion", "evidence"
        FROM "FindingVerification"
        WHERE "workspaceId" = ${workspaceId} AND "findingId" = f."id"
          AND ("status" IN ('VALIDATED', 'VERIFIED') OR "method" = 'RETEST')
        ORDER BY "createdAt" DESC, "id" DESC LIMIT 101
      ) AS r
    ) AS receipts ON true`
  const groups = new Map<string, typeof allFindings>()
  for (const finding of allFindings) {
    const group = groups.get(finding.targetId) ?? []
    group.push(finding)
    groups.set(finding.targetId, group)
  }
  const mismatches = new Set(
    [...groups].filter(([, group]) => group.length > 10000).map(([target]) => target)
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
    if (
      (groups.get(row.targetId) ?? []).some((finding) => finding.verificationReceipts.length > 100)
    ) {
      mismatches.add(row.targetId)
      continue
    }
    const group = groups.get(row.targetId) ?? []
    if (!validSummary(row.evidenceSummary) || !validReasons(row.blockingReasons)) {
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
      findings: prepareGateFindingInputs(group, trusted, row.scanId),
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
          "The stored verdict could not be confirmed against independently verified finding evidence; reassess this target.",
      },
    ],
  }
}
