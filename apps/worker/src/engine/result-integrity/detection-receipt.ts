import { checksum } from "./checksum"
import { prisma } from "@lyrashield/db"
import type { EngineVulnerability } from "../output-parser"
import type { NormalizedFinding } from "../normalizer"

type FindingInput = EngineVulnerability | NormalizedFinding

function isNormalizedFinding(finding: FindingInput): finding is NormalizedFinding {
  return "normalizedSeverity" in finding && "dedupeKey" in finding
}

function candidatePayload(finding: FindingInput, severity: string, dedupeKey: string) {
  const contentHashes = Object.fromEntries(
    Object.entries({
      description: finding.description,
      impact: finding.impact,
      technicalAnalysis: finding.technical_analysis,
      evidence: finding.evidence,
      assumptions: finding.assumptions,
      pocDescription: finding.poc_description,
      pocScriptCode: finding.poc_script_code,
      remediationSteps: finding.remediation_steps,
      cvssBreakdown: finding.cvss_breakdown,
      dependencyMetadata: finding.dependency_metadata,
      // run.json 1.1 evidence — hashed verbatim, never flattened or trusted.
      counterevidence: finding.counterevidence,
      engineConfidence: finding.engine_confidence,
      confidenceRationale: finding.confidence_rationale,
      severityChangeConditions: finding.severity_change_conditions,
      fixVerification: finding.fix_verification,
      contextualCvssReasoning: finding.contextual_cvss_reasoning,
      updateHistory: finding.update_history,
      updatedAt: finding.updated_at,
      evidenceWarnings: finding.evidence_warnings,
      evidenceContractVersion: finding.evidence_contract_version,
      engineVerificationState: finding.engine_verification_state,
    }).flatMap(([key, value]) => (value === undefined ? [] : [[key, checksum(value)]]))
  )
  return {
    id: finding.id,
    title: finding.title,
    severity,
    cwe: finding.cwe ?? null,
    cvss: finding.cvss ?? null,
    dedupeKey,
    findingClass: finding.finding_class ?? null,
    fixEffort: finding.fix_effort ?? null,
    controlIds: finding.control_ids ?? [],
    // Small structured evidence stays literal; large text is hash-bound above.
    advisoryCvss: finding.advisory_cvss ?? null,
    httpExchangeIds: finding.http_exchange_ids ?? [],
    httpExchangeRefsDropped: finding.http_exchange_refs_dropped === true,
    contentHashes,
    codeLocations: (finding.code_locations ?? []).map(
      ({ file, start_line, end_line, label, snippet, fix_before, fix_after }) => ({
        file: file ?? null,
        startLine: start_line ?? null,
        endLine: end_line ?? null,
        label: label ?? null,
        snippetHash: snippet === undefined ? null : checksum(snippet),
        fixBeforeHash: fix_before === undefined ? null : checksum(fix_before),
        fixAfterHash: fix_after === undefined ? null : checksum(fix_after),
      })
    ),
  }
}

export async function persistDetectionReceipt(params: {
  scanId: string
  workspaceId: string
  targetId: string
  findingId: string
  finding: FindingInput
  severity: string
  dedupeKey: string
  /**
   * Checksum of the scan's encrypted proxy-exchange export. Included when the
   * finding cites exchange ids so the refs bind to the exact exported
   * evidence they were validated against.
   */
  httpExchangeArtifactChecksum?: string
}): Promise<void> {
  const normalized = isNormalizedFinding(params.finding) ? params.finding : null
  const payload = candidatePayload(params.finding, params.severity, params.dedupeKey)
  const evidenceHash = checksum(payload)
  const scannerSources = [
    ...new Set(
      normalized?.corroboratingSources ?? [normalized?.scannerSource ?? ("engine" as const)]
    ),
  ]

  for (const scannerSource of scannerSources) {
    const candidate = await prisma.findingCandidate.upsert({
      where: {
        scanId_dedupeKey_scannerSource: {
          scanId: params.scanId,
          dedupeKey: params.dedupeKey,
          scannerSource,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        scanId: params.scanId,
        targetId: params.targetId,
        findingId: params.findingId,
        scannerSource,
        dedupeKey: params.dedupeKey,
        status: "PROMOTED",
        payload,
        evidenceHash,
      },
      update: {
        findingId: params.findingId,
        status: "PROMOTED",
        payload,
        evidenceHash,
      },
    })

    const method = scannerSource === "engine" ? "ENGINE_CLAIM" : "SCANNER_DETECTION"
    const reason =
      scannerSource === "engine"
        ? "Engine claim recorded; independent validation is required before verification."
        : "Scanner detection recorded; an independent validation receipt is required before verification."
    const idempotencyKey = checksum({
      scanId: params.scanId,
      dedupeKey: params.dedupeKey,
      scannerSource,
      status: "DETECTED",
    })

    await prisma.findingVerification.upsert({
      where: { idempotencyKey },
      create: {
        workspaceId: params.workspaceId,
        findingId: params.findingId,
        scanId: params.scanId,
        candidateId: candidate.id,
        status: "DETECTED",
        method,
        reason,
        verifierVersion: "result-integrity-v2",
        evidence: {
          candidateEvidenceHash: evidenceHash,
          ...(params.finding.http_exchange_ids?.length
            ? {
                httpExchangeIds: params.finding.http_exchange_ids,
                httpExchangeArtifactChecksum: params.httpExchangeArtifactChecksum ?? null,
              }
            : {}),
        },
        idempotencyKey,
      },
      update: {},
    })
  }
}
