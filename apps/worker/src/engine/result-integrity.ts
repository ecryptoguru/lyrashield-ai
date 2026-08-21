import { createHash } from "crypto"
import { getWorkspaceContext, prisma, withWorkspaceRLS } from "@lyrashield/db"
import { VIBE_SECURITY_CONTROLS, VIBE_SECURITY_COVERAGE_VERSION } from "@lyrashield/security"
import type { UrlExecutionSummary } from "@lyrashield/types"
import type { EngineVulnerability } from "./output-parser"
import type { NormalizedFinding } from "./normalizer"
import type { ScannerCoverageIssue } from "./scanner-coverage"
import type { AiAppSecurityDiscoveryReceipt } from "./scanners/ai-app-security"

type ResultTarget = {
  id: string
  type: string
  repoFullName?: string | null
  branch?: string | null
  url?: string | null
}

type ResultManifestInput = {
  scanId: string
  target: ResultTarget
  sourceCheckoutAvailable: boolean
  engineFindingCount: number
  coverageIssues: ScannerCoverageIssue[]
  aiAppSecurityDiscovery?: AiAppSecurityDiscoveryReceipt
  matchedControlRanks?: number[]
  urlExecution?: UrlExecutionSummary
  engineExecution?: {
    model: string
    reasoningEffort: string
    image: string | null
    imageDigest?: string
    engineVersion?: string
    promptBundleHash?: string
    delegateModel?: string
    delegateReasoningEffort?: string
    routingPolicy?: string
    compactionTriggerTokens?: number
    compactionTargetTokens?: number
    maxOutputTokens?: number
    maxAgents?: number
    sourceRevision?: string
    sandboxRemoved?: boolean
  }
  accounting?: {
    maxBudgetUsd: number
    billedCostUsd: number | null
    reconciled: boolean
    reconciliationReason?: string
  }
}

type FindingInput = EngineVulnerability | NormalizedFinding

const MANIFEST_VERSION = 4
const SCANNER_CONTRACT_VERSION = "2026-08-21"

type CoverageStatus = "COMPLETED" | "NOT_APPLICABLE" | "BLOCKED"

type FamilyReceipt = {
  scanner: string
  controlId: string
  status: CoverageStatus
  reason?: string
  subject?: string
  metadata: Record<string, unknown>
}

const CONTROL_SCANNERS: Readonly<Record<number, readonly string[]>> = {
  1: ["engine"],
  2: ["engine"],
  3: ["secrets", "url"],
  14: ["url"],
  20: ["engine"],
  27: ["url"],
  28: ["url"],
  29: ["url"],
  31: ["url"],
  32: ["url"],
  33: ["engine", "ai_app_security"],
  37: ["sca"],
  38: ["sca", "engine"],
  39: ["sca", "engine", "ml_supply_chain"],
  40: ["engine", "ai_app_security"],
  42: ["engine", "ai_app_security"],
  44: ["engine", "ai_app_security"],
  45: ["agent_config"],
  47: ["agent_config", "engine"],
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function receiptIdentityCoverageIssues(input: ResultManifestInput): ScannerCoverageIssue[] {
  if (
    input.target.type !== "REPO" ||
    input.coverageIssues.some((issue) => issue.scanner === "engine")
  ) {
    return []
  }

  const execution = input.engineExecution
  const missing: string[] = []
  const requireValue = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === "") missing.push(name)
  }
  requireValue("engineExecution", execution)
  if (execution) {
    requireValue("model", execution.model)
    requireValue("reasoningEffort", execution.reasoningEffort)
    requireValue("imageDigest", execution.imageDigest)
    requireValue("engineVersion", execution.engineVersion)
    requireValue("promptBundleHash", execution.promptBundleHash)
    requireValue("delegateModel", execution.delegateModel)
    requireValue("delegateReasoningEffort", execution.delegateReasoningEffort)
    requireValue("routingPolicy", execution.routingPolicy)
    requireValue("compactionTriggerTokens", execution.compactionTriggerTokens)
    requireValue("compactionTargetTokens", execution.compactionTargetTokens)
    requireValue("maxOutputTokens", execution.maxOutputTokens)
    requireValue("maxAgents", execution.maxAgents)
    requireValue("sourceRevision", execution.sourceRevision)
    if (execution.sandboxRemoved !== true) missing.push("sandboxRemoved")
    if (execution.imageDigest && !/^sha256:[a-f0-9]{64}$/i.test(execution.imageDigest)) {
      missing.push("imageDigest(exact sha256)")
    }
  }
  requireValue("accounting", input.accounting)
  if (input.accounting) {
    if (!input.accounting.reconciled) missing.push("accounting.reconciled")
    requireValue("accounting.billedCostUsd", input.accounting.billedCostUsd)
  }

  return missing.length === 0
    ? []
    : [
        {
          scanner: "engine",
          status: "partial",
          subject: "result-manifest",
          reason: `Immutable repository receipt identity is incomplete: ${missing.join(", ")}`,
        },
      ]
}

function scannerStatus(
  scanner: string,
  applicable: boolean,
  coverageIssues: ScannerCoverageIssue[]
): {
  status: "COMPLETED" | "NOT_APPLICABLE" | "BLOCKED"
  reason?: string
  subject?: string
  metadata?: { issues: ScannerCoverageIssue[] }
} {
  if (!applicable) return { status: "NOT_APPLICABLE", reason: "Not applicable to this target" }
  const issues = coverageIssues
    .filter((candidate) => candidate.scanner === scanner)
    .sort((left, right) =>
      `${left.subject ?? ""}\u0000${left.status}\u0000${left.reason}`.localeCompare(
        `${right.subject ?? ""}\u0000${right.status}\u0000${right.reason}`
      )
    )
  if (issues.length > 0) {
    const reasons = [...new Set(issues.map((issue) => issue.reason))]
    const subjects = [...new Set(issues.flatMap((issue) => (issue.subject ? [issue.subject] : [])))]
    return {
      status: "BLOCKED",
      reason: reasons.join("; "),
      ...(subjects.length > 0 ? { subject: subjects.join(", ") } : {}),
      metadata: { issues },
    }
  }
  return { status: "COMPLETED" }
}

export function buildCoverageReceipts(input: ResultManifestInput) {
  const repositoryTarget = input.target.type === "REPO"
  const engineStatus = scannerStatus("engine", repositoryTarget, input.coverageIssues)
  const urlStatus = scannerStatus("url", Boolean(input.target.url), input.coverageIssues)
  const familyReceipts: FamilyReceipt[] = [
    {
      scanner: "engine",
      controlId: "engine",
      ...engineStatus,
      metadata: {
        findingCount: input.engineFindingCount,
        ...engineStatus.metadata,
      },
    },
    ...["sca", "secrets", "agent_config", "ml_supply_chain", "ai_app_security"].map((scanner) => {
      const status = scannerStatus(
        scanner,
        repositoryTarget && input.sourceCheckoutAvailable,
        input.coverageIssues
      )
      return {
        scanner,
        controlId: scanner,
        ...status,
        metadata: {
          sourceCheckoutAvailable: input.sourceCheckoutAvailable,
          ...(scanner === "ai_app_security"
            ? { discovery: input.aiAppSecurityDiscovery ?? null }
            : {}),
          ...status.metadata,
        },
      }
    }),
    {
      scanner: "url",
      controlId: "url",
      ...urlStatus,
      metadata: {
        configured: Boolean(input.target.url),
        ...urlStatus.metadata,
      },
    },
  ]

  const matchedRanks = new Set(input.matchedControlRanks ?? [])
  const familyByScanner = new Map(familyReceipts.map((receipt) => [receipt.scanner, receipt]))
  const controlReceipts: FamilyReceipt[] = VIBE_SECURITY_CONTROLS.map((control) => {
    const controlId = `vibe-${String(control.rank).padStart(2, "0")}`
    const scanners =
      control.strategy === "engine" ? ["engine"] : (CONTROL_SCANNERS[control.rank] ?? [])
    const applicableReceipts = scanners
      .map((scanner) => familyByScanner.get(scanner))
      .filter((receipt): receipt is FamilyReceipt => Boolean(receipt))
    const metadata = {
      rank: control.rank,
      title: control.title,
      strategy: control.strategy,
      scanners,
      coverageVersion: VIBE_SECURITY_COVERAGE_VERSION,
    }

    if (control.strategy === "evidence") {
      return {
        scanner: "evidence",
        controlId,
        status: "BLOCKED",
        reason: "Requires deployment, operational, or accountable human evidence.",
        metadata: { ...metadata, outcome: "EVIDENCE_REQUIRED" },
      }
    }

    if (
      applicableReceipts.length === 0 ||
      applicableReceipts.every((receipt) => receipt.status === "NOT_APPLICABLE")
    ) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "NOT_APPLICABLE",
        reason: "No applicable scanner ran for this target type.",
        metadata: { ...metadata, outcome: "NOT_APPLICABLE" },
      }
    }

    if (matchedRanks.has(control.rank)) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "COMPLETED",
        reason: "One or more findings were mapped to this control.",
        metadata: { ...metadata, outcome: "DETECTED" },
      }
    }

    const limitedReceipts = applicableReceipts.filter(
      (receipt) => receipt.status !== "COMPLETED" && receipt.status !== "NOT_APPLICABLE"
    )
    if (limitedReceipts.length > 0) {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "BLOCKED",
        reason: `Applicable coverage was limited: ${limitedReceipts
          .map((receipt) => receipt.reason ?? receipt.status)
          .join("; ")}`,
        metadata: { ...metadata, outcome: "INCONCLUSIVE" },
      }
    }

    if (control.strategy === "engine" || control.strategy === "hybrid") {
      return {
        scanner: scanners.join("+") || control.strategy,
        controlId,
        status: "BLOCKED",
        reason:
          control.strategy === "hybrid"
            ? "Available signals did not establish an evidence-backed outcome; absence is inconclusive."
            : "The model completed without an explicit control mapping; absence is inconclusive.",
        metadata: { ...metadata, outcome: "INCONCLUSIVE" },
      }
    }

    return {
      scanner: scanners.join("+") || control.strategy,
      controlId,
      status: "COMPLETED",
      reason:
        "No finding was returned by the completed applicable scanner. This is not independent verification.",
      metadata: { ...metadata, outcome: "NO_FINDING" },
    }
  })

  return [...familyReceipts, ...controlReceipts]
}

export async function persistResultManifest(input: ResultManifestInput): Promise<void> {
  const workspaceId = getWorkspaceContext()
  if (!workspaceId) {
    throw new Error("workspace context is required for persistResultManifest")
  }

  const coverage = buildCoverageReceipts({
    ...input,
    coverageIssues: [...input.coverageIssues, ...receiptIdentityCoverageIssues(input)],
  })
  const manifest = {
    version: MANIFEST_VERSION,
    target: {
      id: input.target.id,
      type: input.target.type,
      repository: input.target.repoFullName ?? null,
      branch: input.target.branch ?? null,
      // Keep URL contents out of the manifest while retaining an integrity signal.
      urlChecksum: input.target.url ? checksum(input.target.url) : null,
    },
    sourceCheckoutAvailable: input.sourceCheckoutAvailable,
    scannerContractVersion: SCANNER_CONTRACT_VERSION,
    urlExecution: input.urlExecution ?? null,
    engineExecution: input.engineExecution ?? null,
    accounting: input.accounting ?? null,
    // Coverage limitations are part of the immutable result contract. Keep
    // their bounded subjects and reasons in the manifest, not only in the
    // mutable receipt table.
    coverage,
  }
  const manifestChecksum = checksum(manifest)

  await withWorkspaceRLS(workspaceId, async (tx) => {
    const existing = await tx.scanResultManifest.findUnique({ where: { scanId: input.scanId } })
    if (existing && existing.checksum !== manifestChecksum) {
      throw new Error("Scan result manifest already exists with different contents")
    }

    await tx.scanCoverageReceipt.createMany({
      data: coverage.map((receipt) => ({ scanId: input.scanId, ...receipt })),
      skipDuplicates: true,
    })

    if (!existing) {
      await tx.scanResultManifest.create({
        data: {
          scanId: input.scanId,
          version: MANIFEST_VERSION,
          manifest,
          checksum: manifestChecksum,
        },
      })
    }
  })
}

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
        evidence: { candidateEvidenceHash: evidenceHash },
        idempotencyKey,
      },
      update: {},
    })
  }
}

export async function markRetestsRunning(scanId: string): Promise<void> {
  await prisma.retest.updateMany({
    where: { scanId, status: "pending" },
    data: { status: "running" },
  })
}

export async function completeRetestsForScan(params: {
  scanId: string
  workspaceId: string
  persistedFindingIds: string[]
  coverageIssues: ScannerCoverageIssue[]
}): Promise<void> {
  const retests = await prisma.retest.findMany({
    where: {
      scanId: params.scanId,
      workspaceId: params.workspaceId,
      status: { in: ["pending", "running"] },
    },
    include: {
      finding: {
        select: {
          id: true,
          candidates: {
            select: { scannerSource: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  })

  for (const retest of retests) {
    if (params.persistedFindingIds.includes(retest.findingId)) {
      await prisma.retest.update({
        where: { id: retest.id },
        data: {
          status: "failed",
          resultAfter: "The finding was detected again during this retest.",
        },
      })
      continue
    }

    const scannerSource = retest.finding.candidates[0]?.scannerSource
    const coverageComplete =
      Boolean(scannerSource) &&
      scannerSource !== "engine" &&
      !params.coverageIssues.some((issue) => issue.scanner === scannerSource)

    if (!coverageComplete) {
      await prisma.retest.update({
        where: { id: retest.id },
        data: {
          status: "inconclusive",
          resultAfter:
            "The finding was not detected, but the originating scanner lacks independent or complete retest coverage.",
        },
      })
      continue
    }

    const reason =
      "The originating deterministic scanner did not detect the finding in the queued retest."
    const idempotencyKey = checksum({
      retestId: retest.id,
      scanId: params.scanId,
      status: "VALIDATED",
    })
    await prisma.$transaction(async (tx) => {
      await tx.finding.update({
        where: { id: retest.findingId },
        data: {
          status: "FIXED",
          fixedAt: new Date(),
          verified: false,
          verificationStatus: "VALIDATED",
          verificationMethod: "RETEST",
          verificationReason: reason,
        },
      })
      await tx.findingVerification.upsert({
        where: { idempotencyKey },
        create: {
          workspaceId: params.workspaceId,
          findingId: retest.findingId,
          scanId: params.scanId,
          status: "VALIDATED",
          method: "RETEST",
          reason,
          verifierVersion: "result-integrity-v1",
          evidence: { retestId: retest.id, scannerSource },
          idempotencyKey,
        },
        update: {},
      })
      await tx.retest.update({
        where: { id: retest.id },
        data: {
          status: "passed",
          resultAfter: "Finding was not detected by the originating scanner.",
        },
      })
    })
  }
}

export async function failTerminalRetestsForScan(scanId: string): Promise<void> {
  const scan = await prisma.scan.findUnique({ where: { id: scanId }, select: { status: true } })
  if (!scan || !["FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(scan.status)) {
    return
  }
  await prisma.retest.updateMany({
    where: { scanId, status: { in: ["pending", "running"] } },
    data: { status: "error", resultAfter: "The retest scan did not complete successfully." },
  })
}

export const resultIntegrity = {
  buildCoverageReceipts,
  persistResultManifest,
  persistDetectionReceipt,
  markRetestsRunning,
  completeRetestsForScan,
  failTerminalRetestsForScan,
}
