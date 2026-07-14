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
    type: "poc" | "code_location"
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
  for (const artifact of artifacts) {
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
  })
  const existingMap = new Map(existingFindings.map((f) => [f.dedupeKey, f]))

  for (const vuln of vulnerabilities) {
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
    const verified = isNormalized
      ? (vuln as NormalizedFinding).scannerSource !== "engine" &&
        (vuln as NormalizedFinding).confidenceScore >= 50
      : verification.verified
    const normalized = isNormalized ? (vuln as NormalizedFinding) : null
    const category =
      normalized?.scannerSource === "secrets" ? "Secrets" : normalized?.enrichment.cweCategory
    const owaspCategory = normalized?.enrichment.owaspCategory

    const existing = existingMap.get(dedupeKey)

    if (existing) {
      // Regression handling: if a previously resolved finding is re-detected, it
      // has reappeared and must be reopened — otherwise the dashboard shows a
      // "fixed" state for an actively-present vulnerability. Only auto-reopen
      // engine-resolved states (FIXED, FIXED_PENDING_RETEST); permanent human
      // dispositions (ACCEPTED_RISK, FALSE_POSITIVE, DUPLICATE) are intentional
      // and must NOT be silently overridden by a re-detection.
      const reopen = existing.status === "FIXED" || existing.status === "FIXED_PENDING_RETEST"
      if (reopen) {
        logger.info("Reopening regressed finding", {
          findingId: existing.id,
          scanId,
          previousStatus: existing.status,
        })
      }
      await prisma.finding.update({
        where: { id: existing.id },
        data: {
          scanId,
          lastSeenAt: new Date(),
          title: vuln.title,
          summary,
          severity,
          confidence,
          ...(cwe ? { cwe } : {}),
          ...(category ? { category } : {}),
          ...(owaspCategory ? { owaspCategory } : {}),
          ...(cvss != null ? { cvssScore: cvss } : {}),
          ...(vuln.technical_analysis ? { technicalDetail: vuln.technical_analysis } : {}),
          ...(vuln.remediation_steps ? { recommendedFix: vuln.remediation_steps } : {}),
          ...(vuln.impact ? { businessImpact: vuln.impact } : {}),
          ...(reopen ? { status: "OPEN" as const, fixedAt: null } : {}),
          verified,
        },
      })
      await persistEvidence(existing.id, workspaceId, vuln)

      results.push({
        id: existing.id,
        title: vuln.title,
        severity,
        dedupeKey,
        isNew: false,
      })
      continue
    }

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

    await persistEvidence(finding.id, workspaceId, vuln)

    results.push({
      id: finding.id,
      title: vuln.title,
      severity,
      dedupeKey,
      isNew: true,
    })
  }

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
