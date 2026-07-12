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
import { uploadEvidence, EVIDENCE_KEY_REF } from "./evidence-storage"

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
      ? (vuln as NormalizedFinding).confidenceScore >= 50
      : verification.verified

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
          ...(cvss != null ? { cvssScore: cvss } : {}),
          ...(vuln.technical_analysis ? { technicalDetail: vuln.technical_analysis } : {}),
          ...(vuln.remediation_steps ? { recommendedFix: vuln.remediation_steps } : {}),
          ...(vuln.impact ? { businessImpact: vuln.impact } : {}),
          ...(reopen ? { status: "OPEN" as const, fixedAt: null } : {}),
          verified,
        },
      })

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
        ...(vuln.cve ? { sarifRuleId: vuln.cve } : {}),
        ...(cvss != null ? { cvssScore: cvss } : {}),
        ...(vuln.technical_analysis ? { technicalDetail: vuln.technical_analysis } : {}),
        ...(vuln.remediation_steps ? { recommendedFix: vuln.remediation_steps } : {}),
        ...(vuln.impact ? { businessImpact: vuln.impact } : {}),
        ...(vuln.poc_description ? { exploitability: vuln.poc_description } : {}),
      },
    })

    // Store evidence as encrypted references — NOT raw PoC data in the DB.
    // The actual PoC content is uploaded to encrypted S3-compatible storage and
    // referenced by URI. The encryptionKeyRef points to the vault key used for
    // envelope encryption.
    if (vuln.poc_script_code || vuln.poc_description) {
      assertEvidenceEncrypted(EVIDENCE_KEY_REF)
      const evidence = await uploadEvidence({
        workspaceId,
        findingId: finding.id,
        type: "poc",
        artifactId: "poc",
        content: vuln.poc_script_code ?? vuln.poc_description ?? "",
        contentType: "text/plain; charset=utf-8",
        encryptionKeyRef: EVIDENCE_KEY_REF,
      })
      await prisma.evidence.create({
        data: {
          findingId: finding.id,
          type: "poc",
          redactionStatus: "pending",
          encryptionKeyRef: evidence.encryptionKeyRef,
          storageUri: evidence.storageUri,
          checksum: evidence.checksum,
        },
      })
    }

    if (vuln.code_locations && vuln.code_locations.length > 0) {
      for (const [i, loc] of vuln.code_locations.entries()) {
        if (loc.snippet || loc.file) {
          assertEvidenceEncrypted(EVIDENCE_KEY_REF)
          const evidence = await uploadEvidence({
            workspaceId,
            findingId: finding.id,
            type: "code_location",
            artifactId: `code-loc-${i}`,
            content: JSON.stringify({
              file: loc.file,
              start_line: loc.start_line,
              end_line: loc.end_line,
              snippet: loc.snippet,
            }),
            contentType: "application/json; charset=utf-8",
            encryptionKeyRef: EVIDENCE_KEY_REF,
          })
          await prisma.evidence.create({
            data: {
              findingId: finding.id,
              type: "code_location",
              redactionStatus: "pending",
              encryptionKeyRef: evidence.encryptionKeyRef,
              storageUri: evidence.storageUri,
              checksum: evidence.checksum,
            },
          })
        }
      }
    }

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
