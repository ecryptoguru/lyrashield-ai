/* eslint-disable security/detect-non-literal-fs-filename */
import { logger } from "@lyrashield/logger"
import { addScanEvent, queryOsvWithCache, type AdvisoryBatchResult } from "@lyrashield/db"
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
import { scanOpenApi } from "./scanners/openapi-scanner"
import {
  scanAiAppSecurity,
  type AiAppSecurityDiscoveryReceipt,
  type AiAppSecurityScanResult,
} from "./scanners/ai-app-security"
import type { UrlScanProfile, UrlExecutionSummary } from "@lyrashield/types"
import { scanAgentConfig } from "./scanners/agent-config-scanner"
import { scanMlSupplyChain } from "./scanners/ml-supply-chain-scanner"
import {
  resolveExactDependencies,
  type ResolvedDependencyInventory,
} from "./scanners/resolved-dependencies"
import { recordCoverageIssue, type ScannerCoverageIssue } from "./scanner-coverage"
import { engineWorkspacePath } from "./workspace-path"
import {
  redactUrlForLogs,
  createEgressProxyFetchFn,
  AI_SECURITY_DETECTOR_VERSION,
  type AISecurityCoverage,
  type AISecuritySignal,
} from "@lyrashield/security"
import { resolve } from "path"
import { mkdir } from "fs/promises"

export interface ScannerOrchestratorConfig {
  scanId: string
  workspaceId: string
  targetId: string
  target: {
    id: string
    type: string
    url?: string | null
    apiSpecUrl?: string | null
    repoFullName?: string | null
    name: string
  }
  goal: string
  mode: string
  engineFindings: EngineVulnerability[]
  workspaceDir?: string
  scannerPhaseTimeoutMs?: number
  isCancelled?: () => Promise<boolean>
  urlProfile?: UrlScanProfile
}

export interface ScannerOrchestratorResult {
  allFindings: NormalizedFinding[]
  engineFindings: NormalizedFinding[]
  scaFindings: NormalizedFinding[]
  secretsFindings: NormalizedFinding[]
  urlFindings: NormalizedFinding[]
  agentConfigFindings: NormalizedFinding[]
  mlSupplyChainFindings: NormalizedFinding[]
  aiAppSecurityFindings: NormalizedFinding[]
  coverageIssues: ScannerCoverageIssue[]
  stats: ReturnType<typeof getFindingStats>
  filteredFalsePositives: number
  urlExecution?: UrlExecutionSummary
  aiAppSecuritySignals?: AISecuritySignal[]
  aiAppSecurityCoverage?: AISecurityCoverage
  ai03AdvisoryFresh?: boolean
  ai03Coverage?: AiAppSecurityScanResult["ai03Coverage"]
  aiAppSecurityDiscovery?: AiAppSecurityDiscoveryReceipt
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
          void addScanEvent(scanId, "scanner", "error", "Scanner phase timed out", {
            timeoutMs,
          }).catch(() => undefined)
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
  signal: AbortSignal,
  resolvedDependencyInventory?: ResolvedDependencyInventory,
  advisoryBatch?: AdvisoryBatchResult,
  cisaFetchFn?: typeof fetch
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting SCA scan phase", { scanId })
    const findings = await scanSca({
      repoPath: workspaceDir,
      workspaceDir,
      coverageIssues,
      signal,
      resolvedDependencyInventory,
      advisoryBatch,
      cisaFetchFn,
    })
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
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting secrets scan phase", { scanId })
    const findings = await scanSecrets({
      repoPath: workspaceDir,
      workspaceDir,
      coverageIssues,
      signal,
    })
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
  profile: UrlScanProfile,
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal,
  apiSpecUrl?: string | null,
  fetchFn?: typeof fetch
): Promise<{ findings: EngineVulnerability[]; execution?: UrlExecutionSummary }> {
  try {
    logger.info("Starting URL scan phase", { scanId, targetUrl: redactUrlForLogs(targetUrl) })
    const isApiContract =
      profile.targetType === "API" && (profile.mode === "STANDARD" || profile.mode === "DEEP")
    const scanResult =
      isApiContract && apiSpecUrl
        ? await scanOpenApi({
            targetUrl,
            apiSpecUrl,
            profile,
            fetchFn,
            signal,
          })
        : await scanUrl({
            targetUrl,
            profile,
            coverageIssues,
            signal,
            fetchFn,
            apiSpecUrl,
          })
    for (const issue of scanResult.issues) {
      recordCoverageIssue(coverageIssues, {
        scanner: "url",
        status:
          issue.code === "LIMIT_REACHED" || issue.code === "OUT_OF_SCOPE" ? "bounded" : "partial",
        subject: issue.subject,
        reason: `${issue.code}: ${issue.reason}`,
      })
    }

    logger.info("URL scan phase complete", { scanId, findingCount: scanResult.findings.length })
    return { findings: scanResult.findings, execution: scanResult.execution }
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

async function runAiAppSecurityScan(
  scanId: string,
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal,
  mode: string,
  dependencyInventory?: ResolvedDependencyInventory,
  advisoryBatch?: AdvisoryBatchResult
): Promise<AiAppSecurityScanResult> {
  try {
    logger.info("Starting AI App Security scan phase", { scanId })
    const result = await scanAiAppSecurity({
      repoPath: workspaceDir,
      workspaceDir,
      coverageIssues,
      signal,
      mode,
      dependencyInventory,
      advisoryBatch,
    })
    logger.info("AI App Security scan phase complete", {
      scanId,
      findingCount: result.findings.length,
    })
    return result
  } catch (err) {
    logger.warn("AI App Security scan phase failed", {
      scanId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function runMlSupplyChainScan(
  scanId: string,
  workspaceDir: string,
  coverageIssues: ScannerCoverageIssue[],
  signal: AbortSignal
): Promise<EngineVulnerability[]> {
  try {
    logger.info("Starting ML supply-chain scan phase", { scanId })
    const findings = await scanMlSupplyChain({ repoPath: workspaceDir, coverageIssues, signal })
    logger.info("ML supply-chain scan phase complete", { scanId, findingCount: findings.length })
    return findings
  } catch (err) {
    logger.warn("ML supply-chain scan phase failed", {
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
  const normalizedMode = config.mode.trim().toUpperCase()
  const aiAppSecurityMode =
    normalizedMode === "STANDARD"
      ? "STANDARD"
      : normalizedMode === "DEEP" || normalizedMode === "CUSTOM"
        ? "DEEP"
        : "QUICK"

  const scanWorkspace = workspaceDir ?? engineWorkspacePath(scanId)
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
  const egressProxyFetchFn =
    env.LYRASHIELD_EGRESS_PROXY_URL && env.LYRASHIELD_EGRESS_PROXY_SECRET
      ? createEgressProxyFetchFn({
          url: env.LYRASHIELD_EGRESS_PROXY_URL,
          secret: env.LYRASHIELD_EGRESS_PROXY_SECRET,
          connectTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_CONNECT_TIMEOUT_MS,
          readTimeoutMs: env.LYRASHIELD_EGRESS_PROXY_READ_TIMEOUT_MS,
        })
      : undefined
  if (targetUrl && config.urlProfile && env.NODE_ENV === "production" && !egressProxyFetchFn) {
    const message =
      "Production URL scans require the authenticated egress proxy; retry after worker configuration is restored"
    await addScanEvent(scanId, "scanner", "error", message, { scanner: "url" })
    throw new Error(message)
  }
  const hasSourceCheckout = target.type === "REPO" && Boolean(workspaceDir)
  const coverageIssues: ScannerCoverageIssue[] = []
  let dependencyInventory: ResolvedDependencyInventory | undefined
  let advisoryBatch: AdvisoryBatchResult | undefined
  if (target.type === "REPO" && !hasSourceCheckout) {
    const reason = "Validated engine source checkout unavailable for repository target"
    for (const scanner of [
      "sca",
      "secrets",
      "agent_config",
      "ml_supply_chain",
      "ai_app_security",
    ] as const) {
      coverageIssues.push({ scanner, status: "unsupported", reason })
    }
    await addScanEvent(
      scanId,
      "scanner",
      "warning",
      "SCA/secrets/AI app security skipped — validated source checkout unavailable for repository target",
      {
        targetType: target.type,
        scanners: ["sca", "secrets", "agent_config", "ml_supply_chain", "ai_app_security"],
      }
    )
  } else if (!hasSourceCheckout) {
    await addScanEvent(
      scanId,
      "scanner",
      "info",
      "SCA/secrets/AI app security skipped — no source checkout for this target type",
      {
        targetType: target.type,
        scanners: ["sca", "secrets", "agent_config", "ml_supply_chain", "ai_app_security"],
      }
    )
  }
  if (hasSourceCheckout) {
    try {
      dependencyInventory = await resolveExactDependencies({
        repoPath: absWorkspace,
        coverageIssues,
      })
      if (dependencyInventory.packages.length > 0) {
        advisoryBatch = await queryOsvWithCache(dependencyInventory.packages)
      }
    } catch (error) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        reason:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Dependency advisory preparation failed",
      })
    }
  }
  const scannerResults = await withScannerPhaseTimeout(
    scanId,
    (signal) =>
      Promise.allSettled([
        hasSourceCheckout
          ? runScaScan(
              scanId,
              absWorkspace,
              coverageIssues,
              signal,
              dependencyInventory,
              advisoryBatch,
              egressProxyFetchFn
            )
          : Promise.resolve([] as EngineVulnerability[]),
        hasSourceCheckout
          ? runSecretsScan(scanId, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
        targetUrl && config.urlProfile
          ? runUrlScan(
              scanId,
              targetUrl,
              config.urlProfile,
              absWorkspace,
              coverageIssues,
              signal,
              target.apiSpecUrl,
              egressProxyFetchFn
            )
          : Promise.resolve({ findings: [] as EngineVulnerability[], execution: undefined }),
        hasSourceCheckout
          ? runAgentConfigScan(scanId, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
        hasSourceCheckout
          ? runAiAppSecurityScan(
              scanId,
              absWorkspace,
              coverageIssues,
              signal,
              config.mode,
              dependencyInventory,
              advisoryBatch
            )
          : Promise.resolve({
              findings: [],
              aiScanResult: {
                signals: [],
                coverage: {
                  version: AI_SECURITY_DETECTOR_VERSION,
                  totalControls: 8,
                  assessedCount: 0,
                  notAssessedCount: 8,
                  detectedCount: 0,
                  noFindingCount: 0,
                  inconclusiveCount: 0,
                  controls: {} as Record<string, unknown>,
                  limitsReached: [],
                  unsupportedFiles: [],
                  truncatedFiles: [],
                },
                provenance: {
                  files: 0,
                  bytes: 0,
                  scannedAt: new Date().toISOString(),
                  limitsReached: [],
                  detectorVersion: AI_SECURITY_DETECTOR_VERSION,
                },
              } as import("@lyrashield/security").AIScanResult,
              ai03AdvisoryFresh: false,
              ai03Coverage: {
                state: "NOT_ASSESSED",
                advisoryStatus: "UNAVAILABLE",
                resolutionStatus: "UNSUPPORTED",
                fresh: false,
                source: "OSV",
                snapshotId: null,
                snapshotChecksum: null,
                fetchedAt: null,
                requestedPackages: 0,
                resolvedPackages: 0,
                unresolvedReasons: ["AI App Security scan requires a source checkout"],
              },
              discovery: {
                version: "ai-app-security-discovery/1",
                mode: aiAppSecurityMode,
                maxFiles:
                  aiAppSecurityMode === "DEEP"
                    ? 1_000
                    : aiAppSecurityMode === "STANDARD"
                      ? 500
                      : 200,
                eligibleFiles: 0,
                scannedFiles: 0,
                skippedFiles: 0,
                scannedBytes: 0,
                representativeSkippedPaths: [],
                skippedByReason: {
                  fileLimit: 0,
                  totalByteLimit: 0,
                  oversized: 0,
                  unreadable: 0,
                },
                limitsReached: [],
              },
            } as AiAppSecurityScanResult),
        hasSourceCheckout
          ? runMlSupplyChainScan(scanId, absWorkspace, coverageIssues, signal)
          : Promise.resolve([] as EngineVulnerability[]),
      ]),
    scannerPhaseTimeoutMs,
    config.isCancelled
  )

  const scannerNames = [
    "sca",
    "secrets",
    "url",
    "agent_config",
    "ai_app_security",
    "ml_supply_chain",
  ] as const
  const rawFindings: EngineVulnerability[][] = []
  let urlExecution: UrlExecutionSummary | undefined
  let aiAppSecuritySignals: AISecuritySignal[] | undefined
  let aiAppSecurityCoverage: AISecurityCoverage | undefined
  let ai03AdvisoryFresh: boolean | undefined
  let ai03Coverage: AiAppSecurityScanResult["ai03Coverage"] | undefined
  let aiAppSecurityDiscovery: AiAppSecurityDiscoveryReceipt | undefined
  for (let index = 0; index < scannerResults.length; index++) {
    const result = scannerResults[index]
    const value =
      result?.status === "fulfilled"
        ? (result.value as
            | EngineVulnerability[]
            | { findings: EngineVulnerability[]; execution?: UrlExecutionSummary }
            | AiAppSecurityScanResult)
        : undefined
    if (value && "findings" in value) {
      rawFindings.push(value.findings)
      if (index === 2 && "execution" in value) {
        urlExecution = value.execution
      }
      if (index === 4 && "aiScanResult" in value) {
        aiAppSecuritySignals = value.aiScanResult.signals
        aiAppSecurityCoverage = value.aiScanResult.coverage
        ai03AdvisoryFresh = value.ai03AdvisoryFresh
        ai03Coverage = value.ai03Coverage
        aiAppSecurityDiscovery = value.discovery
      }
    } else if (Array.isArray(value)) {
      rawFindings.push(value)
    } else {
      rawFindings.push([] as EngineVulnerability[])
    }

    if (result?.status === "rejected") {
      const scanner = scannerNames[index]!
      coverageIssues.push({
        scanner,
        status: "partial",
        reason:
          result.reason instanceof Error ? result.reason.message.slice(0, 500) : "Scanner failed",
      })
    }
  }
  const scaRaw = rawFindings[0] ?? []
  const secretsRaw = rawFindings[1] ?? []
  const urlRaw = rawFindings[2] ?? []
  const agentConfigRaw = rawFindings[3] ?? []
  const aiAppSecurityRaw = rawFindings[4] ?? []
  const mlSupplyChainRaw = rawFindings[5] ?? []

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
  const aiAppSecurityNormalized = normalizeFindings(
    aiAppSecurityRaw.map((finding) => ({ ...finding, scannerSource: "ai_app_security" as const })),
    targetId,
    generateDedupeKey
  )
  const mlSupplyChainNormalized = normalizeFindings(
    mlSupplyChainRaw.map((finding) => ({ ...finding, scannerSource: "ml_supply_chain" as const })),
    targetId,
    generateDedupeKey
  )

  // Filter false positives
  const engineFiltered = filterFalsePositives(engineNormalized)
  const scaFiltered = filterFalsePositives(scaNormalized)
  const secretsFiltered = filterFalsePositives(secretsNormalized)
  const urlFiltered = filterFalsePositives(urlNormalized)
  const agentConfigFiltered = filterFalsePositives(agentConfigNormalized)
  const aiAppSecurityFiltered = filterFalsePositives(aiAppSecurityNormalized)
  const mlSupplyChainFiltered = filterFalsePositives(mlSupplyChainNormalized)

  const filteredFalsePositives =
    engineNormalized.length -
    engineFiltered.length +
    (scaNormalized.length - scaFiltered.length) +
    (secretsNormalized.length - secretsFiltered.length) +
    (urlNormalized.length - urlFiltered.length) +
    (agentConfigNormalized.length - agentConfigFiltered.length) +
    (aiAppSecurityNormalized.length - aiAppSecurityFiltered.length) +
    (mlSupplyChainNormalized.length - mlSupplyChainFiltered.length)

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
    ...aiAppSecurityFiltered,
    ...mlSupplyChainFiltered,
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
    aiAppSecurity: aiAppSecurityFiltered.length,
    mlSupplyChain: mlSupplyChainFiltered.length,
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
    aiAppSecurityFindings: aiAppSecurityFiltered,
    mlSupplyChainFindings: mlSupplyChainFiltered,
    coverageIssues,
    stats,
    filteredFalsePositives,
    urlExecution,
    aiAppSecuritySignals,
    aiAppSecurityCoverage,
    ai03AdvisoryFresh,
    ai03Coverage,
    aiAppSecurityDiscovery,
  }
}
