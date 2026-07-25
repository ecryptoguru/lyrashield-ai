import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  type EngineVulnerability,
  mapSeverity,
  generateDedupeKey,
  buildFindingSummary,
} from "./output-parser"
import { assertEvidenceEncrypted } from "@lyrashield/db"
import { verifyVulnerability } from "./verifier"
import type { NormalizedFinding } from "./normalizer"
import { uploadEvidence } from "./evidence-storage"
import { persistDetectionReceipt } from "./result-integrity"
import { createHash } from "node:crypto"

export interface PersistFindingsParams {
  scanId: string
  workspaceId: string
  targetId: string
  vulnerabilities: EngineVulnerability[] | NormalizedFinding[]
}

export interface PersistedFinding {
  id: string
  title: string
  severity: string
  dedupeKey: string
  isNew: boolean
}

async function persistEvidence(
  findingId: string,
  workspaceId: string,
  vuln: EngineVulnerability | NormalizedFinding
): Promise<void> {
  const artifacts: Array<{
    type: "poc" | "code_location" | "claim_context"
    artifactId: string
    content: string
    contentType: string
  }> = []
  if (vuln.poc_script_code || vuln.poc_description) {
    artifacts.push({
      type: "poc",
      artifactId: "poc",
      content: vuln.poc_script_code ?? vuln.poc_description ?? "",
      contentType: "text/plain; charset=utf-8",
    })
  }
  for (const [index, location] of (vuln.code_locations ?? []).entries()) {
    if (location.snippet || location.file) {
      artifacts.push({
        type: "code_location",
        artifactId: `code-loc-${index}`,
        content: JSON.stringify(location),
        contentType: "application/json; charset=utf-8",
      })
    }
  }
  const claimContext = {
    evidence: vuln.evidence,
    assumptions: vuln.assumptions,
    fixEffort: vuln.fix_effort,
    findingClass: vuln.finding_class,
    dependencyMetadata: vuln.dependency_metadata,
    cvssBreakdown: vuln.cvss_breakdown,
    controlIds: vuln.control_ids,
  }
  if (Object.values(claimContext).some((value) => value !== undefined)) {
    artifacts.push({
      type: "claim_context",
      artifactId: "claim-context",
      content: JSON.stringify(claimContext),
      contentType: "application/json; charset=utf-8",
    })
  }
  if (artifacts.length === 0) return

  // Resolve which artifacts already exist in ONE query instead of a findUnique
  // per artifact. The checksum guard exists to avoid re-uploading bytes to R2 on
  // a retry (the DB row itself is protected by the findingId+checksum unique
  // constraint and createMany's skipDuplicates), so a single batched read is
  // equivalent — and turns 3+ round-trips per finding into 1.
  const artifactChecksums = artifacts.map((artifact) => ({
    artifact,
    checksum: createHash("sha256").update(artifact.content, "utf8").digest("hex"),
  }))
  const existing = await prisma.evidence.findMany({
    where: { findingId, checksum: { in: artifactChecksums.map((entry) => entry.checksum) } },
    select: { checksum: true },
  })
  const existingChecksums = new Set(existing.map((row) => row.checksum))

  for (const { artifact, checksum } of artifactChecksums) {
    if (existingChecksums.has(checksum)) continue

    const uploaded = await uploadEvidence({
      workspaceId,
      findingId,
      type: artifact.type,
      artifactId: artifact.artifactId,
      content: artifact.content,
      contentType: artifact.contentType,
    })
    assertEvidenceEncrypted(uploaded.encryptionKeyRef)
    await prisma.evidence.createMany({
      data: {
        findingId,
        type: artifact.type,
        redactionStatus: "pending",
        encryptionKeyRef: uploaded.encryptionKeyRef,
        storageUri: uploaded.storageUri,
        checksum: uploaded.checksum,
      },
      skipDuplicates: true,
    })
  }
}

export async function persistFindings(params: PersistFindingsParams): Promise<PersistedFinding[]> {
  const { scanId, workspaceId, targetId, vulnerabilities } = params
  const results: PersistedFinding[] = []

  if (vulnerabilities.length === 0) {
    logger.info("No findings to persist", { scanId, targetId })
    return results
  }

  // Batch dedupe: fetch all existing findings for these dedupe keys in one query
  const dedupeKeys = vulnerabilities.map((v) => {
    if ("dedupeKey" in v && "normalizedSeverity" in v) return (v as NormalizedFinding).dedupeKey
    return generateDedupeKey(v, targetId)
  })
  const existingFindings = await prisma.finding.findMany({
    where: { targetId, dedupeKey: { in: dedupeKeys }, deletedAt: null },
    select: { id: true, dedupeKey: true, status: true },
  })
  const existingMap = new Map(existingFindings.map((f) => [f.dedupeKey, f]))

  // Persist each finding's create/update + evidence + detection receipt as an
  // atomic per-finding sequence, but overlap findings with bounded concurrency
  // so a scan with many findings doesn't serialize hundreds of R2 uploads and
  // DB round-trips. Correctness is preserved: each finding is independent (keyed
  // by its own dedupeKey), the reopen logic and verification receipts are
  // unchanged, and results are collected in stable input order.
  const persistOne = async (vuln: (typeof vulnerabilities)[number]): Promise<PersistedFinding> => {
    const isNormalized = "dedupeKey" in vuln && "normalizedSeverity" in vuln
    const dedupeKey = isNormalized
      ? (vuln as NormalizedFinding).dedupeKey
      : generateDedupeKey(vuln, targetId)
    const severity = isNormalized
      ? (vuln as NormalizedFinding).normalizedSeverity
      : mapSeverity(vuln.severity)
    const summary = buildFindingSummary(vuln)
    const verification = verifyVulnerability(vuln)
    const confidence = isNormalized
      ? (vuln as NormalizedFinding).confidenceScore >= 80
        ? "high"
        : (vuln as NormalizedFinding).confidenceScore >= 50
          ? "medium"
          : "low"
      : verification.confidence
    const cwe = isNormalized ? (vuln as NormalizedFinding).normalizedCwe : vuln.cwe
    const cvss = isNormalized ? (vuln as NormalizedFinding).normalizedCvss : vuln.cvss
    // A scanner's confidence is useful triage data, not proof. Verification is
    // only granted by a separate immutable verification receipt.
    const verified = false
    const normalized = isNormalized ? (vuln as NormalizedFinding) : null
    const scannerSource = normalized?.scannerSource ?? "engine"
    const sources = normalized?.corroboratingSources ?? (scannerSource ? [scannerSource] : [])
    const hasDeterministicCorroboration = sources.some((source) => source !== "engine")
    const isEngineOnlyClaim = !hasDeterministicCorroboration && scannerSource === "engine"
    const verificationMethod = hasDeterministicCorroboration
      ? "SCANNER_DETECTION"
      : scannerSource === "engine"
        ? "ENGINE_CLAIM"
        : "SCANNER_DETECTION"
    const verificationStatus = isEngineOnlyClaim ? "INCONCLUSIVE" : "DETECTED"
    const verificationReason = isEngineOnlyClaim
      ? "Engine-only claim with no deterministic corroboration; treated as inconclusive until independently validated."
      : hasDeterministicCorroboration
        ? "Corroborated by one or more deterministic scanners; independent validation still required for verification."
        : scannerSource === "engine"
          ? "Engine claim recorded; independent validation is required before verification."
          : "Scanner detection recorded; an independent validation receipt is required before verification."
    const category =
      normalized?.scannerSource === "secrets" ? "Secrets" : normalized?.enrichment.cweCategory
    const owaspCategory = normalized?.enrichment.owaspCategory

    function isPrismaUniqueConstraintViolation(err: unknown): boolean {
      return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "P2002"
      )
    }

    function isReopenableStatus(status?: string | null): boolean {
      return status === "FIXED" || status === "FIXED_PENDING_RETEST"
    }

    async function finalizeFinding(findingId: string): Promise<void> {
      await persistEvidence(findingId, workspaceId, vuln)
      await persistDetectionReceipt({
        scanId,
        workspaceId,
        targetId,
        findingId,
        finding: vuln,
        severity,
        dedupeKey,
      })
    }

    async function updateFindingRecord(findingId: string, reopen: boolean): Promise<void> {
      await prisma.finding.update({
        where: { id: findingId },
        data: {
          scanId,
          lastSeenAt: new Date(),
          title: vuln.title,
          summary,
          severity,
          confidence,
          cwe: cwe ?? null,
          category: category ?? null,
          owaspCategory: owaspCategory ?? null,
          sarifRuleId: vuln.cve ?? null,
          cvssScore: cvss ?? null,
          technicalDetail: vuln.technical_analysis ?? null,
          recommendedFix: vuln.remediation_steps ?? null,
          businessImpact: vuln.impact ?? null,
          exploitability: vuln.poc_description ?? null,
          ...(reopen ? { status: "OPEN" as const, fixedAt: null } : {}),
          verified,
          verificationStatus,
          verificationMethod,
          verificationReason,
        },
      })
      await finalizeFinding(findingId)
    }

    const existing = existingMap.get(dedupeKey)

    if (existing) {
      // Regression handling: if a previously resolved finding is re-detected, it
      // has reappeared and must be reopened — otherwise the dashboard shows a
      // "fixed" state for an actively-present vulnerability. Only auto-reopen
      // engine-resolved states (FIXED, FIXED_PENDING_RETEST); permanent human
      // dispositions (ACCEPTED_RISK, FALSE_POSITIVE, DUPLICATE) are intentional
      // and must NOT be silently overridden by a re-detection.
      const reopen = isReopenableStatus(existing.status)
      if (reopen) {
        logger.info("Reopening regressed finding", {
          findingId: existing.id,
          scanId,
          previousStatus: existing.status,
        })
      }
      await updateFindingRecord(existing.id, reopen)

      return {
        id: existing.id,
        title: vuln.title,
        severity,
        dedupeKey,
        isNew: false,
      }
    }

    let findingId: string
    let isNew = true
    try {
      const finding = await prisma.finding.create({
        data: {
          workspaceId,
          targetId,
          scanId,
          title: vuln.title,
          summary,
          severity,
          confidence,
          verified,
          verificationStatus,
          verificationMethod,
          verificationReason,
          dedupeKey,
          ...(cwe ? { cwe } : {}),
          ...(category ? { category } : {}),
          ...(owaspCategory ? { owaspCategory } : {}),
          ...(vuln.cve ? { sarifRuleId: vuln.cve } : {}),
          ...(cvss != null ? { cvssScore: cvss } : {}),
          ...(vuln.technical_analysis ? { technicalDetail: vuln.technical_analysis } : {}),
          ...(vuln.remediation_steps ? { recommendedFix: vuln.remediation_steps } : {}),
          ...(vuln.impact ? { businessImpact: vuln.impact } : {}),
          ...(vuln.poc_description ? { exploitability: vuln.poc_description } : {}),
        },
      })
      findingId = finding.id
    } catch (err) {
      // The targetId+dedupeKey unique constraint may race with another worker.
      // Recover by updating the finding that was just inserted by the winner.
      if (!isPrismaUniqueConstraintViolation(err)) throw err
      const recovered = await prisma.finding.findUnique({
        where: { targetId_dedupeKey: { targetId, dedupeKey } },
        select: { id: true, status: true },
      })
      if (!recovered) throw err
      logger.info("Recovered from dedupe race", { findingId: recovered.id, scanId, dedupeKey })
      findingId = recovered.id
      isNew = false
      await updateFindingRecord(recovered.id, isReopenableStatus(recovered.status))
    }

    if (isNew) {
      await finalizeFinding(findingId)
    }

    return {
      id: findingId,
      title: vuln.title,
      severity,
      dedupeKey,
      isNew,
    }
  }

  // Bounded-concurrency map preserving input order. Concurrency of 5 overlaps
  // the I/O-bound evidence uploads without overwhelming the DB pool or R2.
  // Each finding is wrapped in its own try/catch so a single failure does not
  // leave sibling workers dangling or emit undefined holes into the result.
  const CONCURRENCY = 5
  const ordered: (PersistedFinding | undefined)[] = new Array(vulnerabilities.length)
  const errors: Error[] = []
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= vulnerabilities.length) return
      try {
        ordered[index] = await persistOne(vulnerabilities[index]!)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, vulnerabilities.length) }, () => worker())
  )
  if (errors.length > 0) {
    throw errors[0]
  }
  results.push(...ordered.filter((r): r is PersistedFinding => r !== undefined))

  const newCount = results.filter((r) => r.isNew).length
  const dupCount = results.length - newCount
  logger.info("Findings persisted", {
    scanId,
    total: results.length,
    new: newCount,
    duplicate: dupCount,
  })

  return results
}
