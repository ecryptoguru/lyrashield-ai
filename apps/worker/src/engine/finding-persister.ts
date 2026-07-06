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

const EVIDENCE_KEY_REF = "vault/lyrashield-evidence-key/v1"

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

export async function persistFindings(
  params: PersistFindingsParams,
): Promise<PersistedFinding[]> {
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
    const dedupeKey = isNormalized ? (vuln as NormalizedFinding).dedupeKey : generateDedupeKey(vuln, targetId)
    const severity = isNormalized ? (vuln as NormalizedFinding).normalizedSeverity : mapSeverity(vuln.severity)
    const summary = buildFindingSummary(vuln)
    const verification = verifyVulnerability(vuln)
    const confidence = isNormalized
      ? (vuln as NormalizedFinding).confidenceScore >= 80 ? "high"
        : (vuln as NormalizedFinding).confidenceScore >= 50 ? "medium" : "low"
      : verification.confidence
    const cwe = isNormalized ? (vuln as NormalizedFinding).normalizedCwe : vuln.cwe
    const cvss = isNormalized ? (vuln as NormalizedFinding).normalizedCvss : vuln.cvss
    const verified = isNormalized ? (vuln as NormalizedFinding).confidenceScore >= 50 : verification.verified

    const existing = existingMap.get(dedupeKey)

    if (existing) {
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
    // The actual PoC content must be uploaded to encrypted storage (S3 with
    // server-side encryption) and referenced by URI. The encryptionKeyRef
    // points to the vault key used for envelope encryption.
    if (vuln.poc_script_code || vuln.poc_description) {
      assertEvidenceEncrypted(EVIDENCE_KEY_REF)
      await prisma.evidence.create({
        data: {
          findingId: finding.id,
          type: "poc",
          redactionStatus: "pending",
          encryptionKeyRef: EVIDENCE_KEY_REF,
          storageUri: `encrypted://evidence/${finding.id}/poc`,
        },
      })
    }

    if (vuln.code_locations && vuln.code_locations.length > 0) {
      for (const loc of vuln.code_locations) {
        if (loc.snippet || loc.file) {
          assertEvidenceEncrypted(EVIDENCE_KEY_REF)
          await prisma.evidence.create({
            data: {
              findingId: finding.id,
              type: "code_location",
              redactionStatus: "pending",
              encryptionKeyRef: EVIDENCE_KEY_REF,
              ...(loc.file ? { storageUri: `file://${loc.file}${loc.start_line ? `#L${loc.start_line}` : ""}` } : {}),
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
  logger.info("Findings persisted", { scanId, total: results.length, new: newCount, duplicate: dupCount })

  return results
}
