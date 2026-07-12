/* eslint-disable security/detect-non-literal-fs-filename */
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "./output-parser"
import { generateDedupeKey } from "./output-parser"
import {
  normalizeFindings,
  filterFalsePositives,
  getFindingStats,
  type NormalizedFinding,
} from "./normalizer"
import { scanSca } from "./scanners/sca-scanner"
import { scanSecrets } from "./scanners/secrets-scanner"
import { scanUrl } from "./scanners/url-scanner"
import { join, resolve } from "path"
import { mkdir } from "fs/promises"

export interface ScannerOrchestratorConfig {
  scanId: string
  workspaceId: string
  targetId: string
  target: {
    id: string
    type: string
    url?: string | null
    repoFullName?: string | null
    name: string
  }
  goal: string
  mode: string
  engineFindings: EngineVulnerability[]
  workspaceDir?: string
}

export interface ScannerOrchestratorResult {
  allFindings: NormalizedFinding[]
  engineFindings: NormalizedFinding[]
  scaFindings: NormalizedFinding[]
  secretsFindings: NormalizedFinding[]
  urlFindings: NormalizedFinding[]
  stats: ReturnType<typeof getFindingStats>
  filteredFalsePositives: number
}

async function runScaScan(scanId: string, workspaceDir: string): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting SCA scan phase", { scanId })
    const findings = await scanSca({ repoPath: workspaceDir, workspaceDir })
    logger.info("SCA scan phase complete", { scanId, findingCount: findings.length })
    return findings
  } catch (err) {
    logger.warn("SCA scan phase failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function runSecretsScan(
  scanId: string,
  workspaceDir: string
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting secrets scan phase", { scanId })
    const findings = await scanSecrets({ repoPath: workspaceDir, workspaceDir })
    logger.info("Secrets scan phase complete", { scanId, findingCount: findings.length })
    return findings
  } catch (err) {
    logger.warn("Secrets scan phase failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function runUrlScan(
  scanId: string,
  targetUrl: string,
  workspaceDir: string
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting URL scan phase", { scanId, targetUrl })
    const findings = await scanUrl({ targetUrl, repoPath: workspaceDir })
    logger.info("URL scan phase complete", { scanId, findingCount: findings.length })
    return findings
  } catch (err) {
    logger.warn("URL scan phase failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

export async function runScannerOrchestrator(
  config: ScannerOrchestratorConfig
): Promise<ScannerOrchestratorResult> {
  const { scanId, targetId, target, engineFindings, workspaceDir } = config

  const scanWorkspace = workspaceDir ?? join(process.cwd(), "lyrashield_runs", scanId)
  const absWorkspace = resolve(scanWorkspace)
  await mkdir(absWorkspace, { recursive: true })

  logger.info("Scanner orchestrator starting", {
    scanId,
    targetId,
    targetType: target.type,
    engineFindings: engineFindings.length,
  })

  // Run SCA, secrets, and URL scans in parallel
  const targetUrl = target.url ?? ""
  const [scaRaw, secretsRaw, urlRaw] = await Promise.all([
    runScaScan(scanId, absWorkspace),
    runSecretsScan(scanId, absWorkspace),
    targetUrl
      ? runUrlScan(scanId, targetUrl, absWorkspace)
      : Promise.resolve([] as EngineVulnerability[]),
  ])

  // Normalize each category separately with the dedupe key function
  const engineNormalized = normalizeFindings(
    engineFindings.map((finding) => ({ ...finding, scannerSource: "engine" as const })),
    targetId,
    generateDedupeKey
  )
  const scaNormalized = normalizeFindings(
    scaRaw.map((finding) => ({ ...finding, scannerSource: "sca" as const })),
    targetId,
    generateDedupeKey
  )
  const secretsNormalized = normalizeFindings(
    secretsRaw.map((finding) => ({ ...finding, scannerSource: "secrets" as const })),
    targetId,
    generateDedupeKey
  )
  const urlNormalized = normalizeFindings(
    urlRaw.map((finding) => ({ ...finding, scannerSource: "url" as const })),
    targetId,
    generateDedupeKey
  )

  // Filter false positives
  const engineFiltered = filterFalsePositives(engineNormalized)
  const scaFiltered = filterFalsePositives(scaNormalized)
  const secretsFiltered = filterFalsePositives(secretsNormalized)
  const urlFiltered = filterFalsePositives(urlNormalized)

  const filteredFalsePositives =
    engineNormalized.length -
    engineFiltered.length +
    (scaNormalized.length - scaFiltered.length) +
    (secretsNormalized.length - secretsFiltered.length) +
    (urlNormalized.length - urlFiltered.length)

  // Merge all findings, deduping across sources by dedupeKey.
  // When two sources produce the same dedupeKey, keep the one with higher
  // severity (then higher confidence as tiebreaker).
  const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 }
  const merged = new Map<string, NormalizedFinding>()
  for (const finding of [...engineFiltered, ...scaFiltered, ...secretsFiltered, ...urlFiltered]) {
    const existing = merged.get(finding.dedupeKey)
    if (!existing) {
      merged.set(finding.dedupeKey, finding)
      continue
    }
    const existingRank = SEVERITY_RANK[existing.normalizedSeverity] ?? 0
    const newRank = SEVERITY_RANK[finding.normalizedSeverity] ?? 0
    if (
      newRank > existingRank ||
      (newRank === existingRank && finding.confidenceScore > existing.confidenceScore)
    ) {
      merged.set(finding.dedupeKey, finding)
    }
  }

  const allFindings = Array.from(merged.values())
  const stats = getFindingStats(allFindings)

  logger.info("Scanner orchestrator complete", {
    scanId,
    totalFindings: allFindings.length,
    engine: engineFiltered.length,
    sca: scaFiltered.length,
    secrets: secretsFiltered.length,
    url: urlFiltered.length,
    falsePositivesFiltered: filteredFalsePositives,
    stats,
  })

  return {
    allFindings,
    engineFindings: engineFiltered,
    scaFindings: scaFiltered,
    secretsFindings: secretsFiltered,
    urlFindings: urlFiltered,
    stats,
    filteredFalsePositives,
  }
}
