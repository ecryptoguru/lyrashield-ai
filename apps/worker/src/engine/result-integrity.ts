import { createHash } from "crypto"
import { prisma } from "@lyrashield/db"
import type { EngineVulnerability } from "./output-parser"
import type { NormalizedFinding } from "./normalizer"
import type { ScannerCoverageIssue } from "./scanner-coverage"

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
}

type FindingInput = EngineVulnerability | NormalizedFinding

const MANIFEST_VERSION = 1

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
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
  return [
    {
      scanner: "engine",
      controlId: "engine",
      ...engineStatus,
      metadata: {
        findingCount: input.engineFindingCount,
        ...engineStatus.metadata,
      },
    },
    ...["sca", "secrets", "agent_config"].map((scanner) => {
      const status = scannerStatus(
        scanner,
        repositoryTarget && input.sourceCheckoutAvailable,
        input.coverageIssues
      )
      return {
        scanner,
        controlId: scanner,
        ...status,
        metadata: { sourceCheckoutAvailable: input.sourceCheckoutAvailable, ...status.metadata },
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
}

export async function persistResultManifest(input: ResultManifestInput): Promise<void> {
  const coverage = buildCoverageReceipts(input)
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
    // Coverage limitations are part of the immutable result contract. Keep
    // their bounded subjects and reasons in the manifest, not only in the
    // mutable receipt table.
    coverage,
  }
  const manifestChecksum = checksum(manifest)
  const existing = await prisma.scanResultManifest.findUnique({ where: { scanId: input.scanId } })

  if (existing && existing.checksum !== manifestChecksum) {
    throw new Error("Scan result manifest already exists with different contents")
  }

  // If this insert succeeds but the process stops before the manifest write,
  // the next attempt can safely repeat it. Once the manifest exists, the
  // worker resumes finalization rather than replaying the scan result.
  await prisma.scanCoverageReceipt.createMany({
    data: coverage.map((receipt) => ({ scanId: input.scanId, ...receipt })),
    skipDuplicates: true,
  })

  if (!existing) {
    await prisma.scanResultManifest.create({
      data: {
        scanId: input.scanId,
        version: MANIFEST_VERSION,
        manifest,
        checksum: manifestChecksum,
      },
    })
  }
}

function isNormalizedFinding(finding: FindingInput): finding is NormalizedFinding {
  return "normalizedSeverity" in finding && "dedupeKey" in finding
}

function candidatePayload(finding: FindingInput, severity: string, dedupeKey: string) {
  return {
    id: finding.id,
    title: finding.title,
    severity,
    cwe: finding.cwe ?? null,
    cvss: finding.cvss ?? null,
    dedupeKey,
    codeLocations: (finding.code_locations ?? []).map(({ file, start_line, end_line, label }) => ({
      file: file ?? null,
      startLine: start_line ?? null,
      endLine: end_line ?? null,
      label: label ?? null,
    })),
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
  const scannerSource = normalized?.scannerSource ?? "engine"
  const payload = candidatePayload(params.finding, params.severity, params.dedupeKey)
  const evidenceHash = checksum(payload)
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
      verifierVersion: "result-integrity-v1",
      evidence: { candidateEvidenceHash: evidenceHash },
      idempotencyKey,
    },
    update: {},
  })
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
    await prisma.finding.update({
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
    const idempotencyKey = checksum({
      retestId: retest.id,
      scanId: params.scanId,
      status: "VALIDATED",
    })
    await prisma.findingVerification.upsert({
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
    await prisma.retest.update({
      where: { id: retest.id },
      data: {
        status: "passed",
        resultAfter: "Finding was not detected by the originating scanner.",
      },
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
