/* eslint-disable security/detect-non-literal-fs-filename */
import { logger } from "@lyrashield/logger"
import { addScanEvent } from "@lyrashield/db"
import { env } from "@lyrashield/config"
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
import { scanAgentConfig } from "./scanners/agent-config-scanner"
import type { ScannerCoverageIssue } from "./scanner-coverage"
import { redactUrlForLogs } from "@lyrashield/security"
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
  scannerPhaseTimeoutMs?: number
  isCancelled?: () => Promise<boolean>
}

export interface ScannerOrchestratorResult {
  allFindings: NormalizedFinding[]
  engineFindings: NormalizedFinding[]
  scaFindings: NormalizedFinding[]
  secretsFindings: NormalizedFinding[]
  urlFindings: NormalizedFinding[]
  agentConfigFindings: NormalizedFinding[]
  coverageIssues: ScannerCoverageIssue[]
  stats: ReturnType<typeof getFindingStats>
  filteredFalsePositives: number
}

async function withScannerPhaseTimeout<T>(
  scanId: string,
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  isCancelled?: () => Promise<boolean>
): Promise<T> {
  const controller = new AbortController()
  const phase = start(controller.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancellationTimer: ReturnType<typeof setInterval> | undefined
  let settled = false
  try {
    return await Promise.race([
      phase,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          void addScanEvent(scanId, "scanner", "error", "Scanner phase timed out", { timeoutMs })
          reject(new Error(`Scanner phase timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        if (isCancelled) {
          const checkCancellation = () => {
            void isCancelled()
              .then((cancelled) => {
                if (settled || !cancelled) return
                controller.abort()
                reject(new Error("Scanner phase cancelled"))
              })
              .catch(() => undefined)
          }
          checkCancellation()
          cancellationTimer = setInterval(checkCancellation, 1000)
        }
      }),
    ])
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
    if (cancellationTimer) clearInterval(cancellationTimer)
    // Do not await an uncooperative phase after timing out; that defeats the deadline.
    void phase.catch(() => undefined)
  }
}

async function runScaScan(
  scanId: string,
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting SCA scan phase", { scanId })
    const findings = await scanSca({ repoPath: workspaceDir, workspaceDir, coverageIssues, signal })
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
  workspaceDir: string,
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting secrets scan phase", { scanId })
    const findings = await scanSecrets({ repoPath: workspaceDir, workspaceDir, signal })
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
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting URL scan phase", { scanId, targetUrl: redactUrlForLogs(targetUrl) })
    const findings = await scanUrl({ targetUrl, repoPath: workspaceDir, coverageIssues, signal })
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

async function runAgentConfigScan(
  scanId: string,
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting agent configuration scan phase", { scanId })
    const findings = await scanAgentConfig({ repoPath: workspaceDir, coverageIssues, signal })
    logger.info("Agent configuration scan phase complete", {
      scanId,
      findingCount: findings.length,
    })
    return findings
  } catch (err) {
    logger.warn("Agent configuration scan phase failed", {
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
  const scannerPhaseTimeoutMs = config.scannerPhaseTimeoutMs ?? env.SCANNER_PHASE_TIMEOUT_MS

  const scanWorkspace = workspaceDir ?? join(process.cwd(), "lyrashield_runs", scanId)
  const absWorkspace = resolve(scanWorkspace)
  // An absent repository checkout must not become a newly created empty
  // directory that source scanners would misreport as clean.
  if (target.type !== "REPO" && !workspaceDir) {
    await mkdir(absWorkspace, { recursive: true })
  }

  logger.info("Scanner orchestrator starting", {
    scanId,
    targetId,
    targetType: target.type,
    engineFindings: engineFindings.length,
  })

  // Source scanners must never report an empty or unvalidated repository
  // workspace as clean. The engine supplies the checkout after cloning it.
  const targetUrl = target.url ?? ""
  const hasSourceCheckout = target.type === "REPO" && Boolean(workspaceDir)
  const coverageIssues: ScannerCoverageIssue[] = []
  if (target.type === "REPO" && !hasSourceCheckout) {
    const reason = "Validated engine source checkout unavailable for repository target"
    for (const scanner of ["sca", "secrets", "agent_config"] as const) {
      coverageIssues.push({ scanner, status: "unsupported", reason })
    }
    await addScanEvent(
      scanId,
      "scanner",
      "warning",
      "SCA/secrets skipped — validated source checkout unavailable for repository target",
      { targetType: target.type, scanners: ["sca", "secrets", "agent_config"] }
    )
  } else if (!hasSourceCheckout) {
    await addScanEvent(
      scanId,
      "scanner",
      "info",
      "SCA/secrets skipped — no source checkout for this target type",
      { targetType: target.type, scanners: ["sca", "secrets", "agent_config"] }
    )
  }
  const scannerResults = await withScannerPhaseTimeout(
    scanId,
    (signal) =>
      Promise.allSettled([
        hasSourceCheckout
          ? runScaScan(scanId, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
        hasSourceCheckout
          ? runSecretsScan(scanId, absWorkspace, signal)
          : Promise.resolve([] as EngineVulnerability[]),
        targetUrl
          ? runUrlScan(scanId, targetUrl, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
        hasSourceCheckout
          ? runAgentConfigScan(scanId, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
      ]),
    scannerPhaseTimeoutMs,
    config.isCancelled
  )

  const scannerNames = ["sca", "secrets", "url", "agent_config"] as const
  const rawFindings = scannerResults.map((result, index) => {
    if (result.status === "fulfilled") return result.value
    const scanner = scannerNames[index]!
    coverageIssues.push({
      scanner,
      status: "partial",
      reason:
        result.reason instanceof Error ? result.reason.message.slice(0, 500) : "Scanner failed",
    })
    return [] as EngineVulnerability[]
  })
  const scaRaw = rawFindings[0] ?? []
  const secretsRaw = rawFindings[1] ?? []
  const urlRaw = rawFindings[2] ?? []
  const agentConfigRaw = rawFindings[3] ?? []

  for (const issue of coverageIssues) {
    await addScanEvent(scanId, "scanner", "warning", "Deterministic scanner coverage incomplete", {
      ...issue,
    })
  }

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
  const agentConfigNormalized = normalizeFindings(
    agentConfigRaw.map((finding) => ({ ...finding, scannerSource: "agent_config" as const })),
    targetId,
    generateDedupeKey
  )

  // Filter false positives
  const engineFiltered = filterFalsePositives(engineNormalized)
  const scaFiltered = filterFalsePositives(scaNormalized)
  const secretsFiltered = filterFalsePositives(secretsNormalized)
  const urlFiltered = filterFalsePositives(urlNormalized)
  const agentConfigFiltered = filterFalsePositives(agentConfigNormalized)

  const filteredFalsePositives =
    engineNormalized.length -
    engineFiltered.length +
    (scaNormalized.length - scaFiltered.length) +
    (secretsNormalized.length - secretsFiltered.length) +
    (urlNormalized.length - urlFiltered.length) +
    (agentConfigNormalized.length - agentConfigFiltered.length)

  // Merge all findings, deduping across sources by dedupeKey.
  // When two sources produce the same dedupeKey, keep the one with higher
  // severity (then higher confidence as tiebreaker).
  const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 }
  const merged = new Map<string, NormalizedFinding>()
  for (const finding of [
    ...engineFiltered,
    ...scaFiltered,
    ...secretsFiltered,
    ...urlFiltered,
    ...agentConfigFiltered,
  ]) {
    const existing = merged.get(finding.dedupeKey)
    if (!existing) {
      merged.set(finding.dedupeKey, finding)
      continue
    }
    const existingRank = SEVERITY_RANK[existing.normalizedSeverity] ?? 0
    const newRank = SEVERITY_RANK[finding.normalizedSeverity] ?? 0
    const corroboratingSources = [
      ...new Set([
        ...(existing.corroboratingSources ??
          (existing.scannerSource ? [existing.scannerSource] : [])),
        ...(finding.corroboratingSources ?? (finding.scannerSource ? [finding.scannerSource] : [])),
      ]),
    ]
    if (
      newRank > existingRank ||
      (newRank === existingRank && finding.confidenceScore > existing.confidenceScore)
    ) {
      merged.set(finding.dedupeKey, { ...finding, corroboratingSources })
    } else {
      merged.set(finding.dedupeKey, { ...existing, corroboratingSources })
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
    agentConfig: agentConfigFiltered.length,
    falsePositivesFiltered: filteredFalsePositives,
    stats,
  })

  return {
    allFindings,
    engineFindings: engineFiltered,
    scaFindings: scaFiltered,
    secretsFindings: secretsFiltered,
    urlFindings: urlFiltered,
    agentConfigFindings: agentConfigFiltered,
    coverageIssues,
    stats,
    filteredFalsePositives,
  }
}
