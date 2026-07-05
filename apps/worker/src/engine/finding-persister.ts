import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  type EngineVulnerability,
  mapSeverity,
  generateDedupeKey,
  buildFindingSummary,
} from "./output-parser"
import { assertEvidenceEncrypted } from "@lyrashield/db"

const EVIDENCE_KEY_REF = "vault/lyrashield-evidence-key/v1"

export interface PersistFindingsParams {
  scanId: string
  workspaceId: string
  targetId: string
  vulnerabilities: EngineVulnerability[]
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
  const dedupeKeys = vulnerabilities.map((v) => generateDedupeKey(v, targetId))
  const existingFindings = await prisma.finding.findMany({
    where: { targetId, dedupeKey: { in: dedupeKeys }, deletedAt: null },
  })
  const existingMap = new Map(existingFindings.map((f) => [f.dedupeKey, f]))

  for (const vuln of vulnerabilities) {
    const dedupeKey = generateDedupeKey(vuln, targetId)
    const severity = mapSeverity(vuln.severity)
    const summary = buildFindingSummary(vuln)

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
          ...(vuln.cwe ? { cwe: vuln.cwe } : {}),
          ...(vuln.cvss ? { cvssScore: vuln.cvss } : {}),
          ...(vuln.technical_analysis ? { technicalDetail: vuln.technical_analysis } : {}),
          ...(vuln.remediation_steps ? { recommendedFix: vuln.remediation_steps } : {}),
          ...(vuln.impact ? { businessImpact: vuln.impact } : {}),
          verified: true,
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
        confidence: "medium",
        verified: true,
        dedupeKey,
        ...(vuln.cwe ? { cwe: vuln.cwe } : {}),
        ...(vuln.cve ? { sarifRuleId: vuln.cve } : {}),
        ...(vuln.cvss ? { cvssScore: vuln.cvss } : {}),
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
      await prisma.evidence.create({
        data: {
          findingId: finding.id,
          type: "poc",
          redactionStatus: "pending",
          encryptionKeyRef: EVIDENCE_KEY_REF,
          storageUri: `encrypted://evidence/${finding.id}/poc`,
        },
      })
      assertEvidenceEncrypted(EVIDENCE_KEY_REF)
    }

    if (vuln.code_locations && vuln.code_locations.length > 0) {
      for (const loc of vuln.code_locations) {
        if (loc.snippet || loc.file) {
          const evidenceRec = await prisma.evidence.create({
            data: {
              findingId: finding.id,
              type: "code_location",
              redactionStatus: "pending",
              encryptionKeyRef: EVIDENCE_KEY_REF,
              ...(loc.file ? { storageUri: `file://${loc.file}${loc.start_line ? `#L${loc.start_line}` : ""}` } : {}),
            },
          })
          assertEvidenceEncrypted(evidenceRec.encryptionKeyRef)
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
