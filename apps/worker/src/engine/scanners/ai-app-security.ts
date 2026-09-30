import { logger } from "@lyrashield/logger"
import {
  AI_SECURITY_CONTROLS,
  AI_SECURITY_CONTROLS_BY_ID,
  AI_SECURITY_DETECTOR_VERSION,
  buildSignal,
  scanAiSecurityFiles,
  summarizeAiSecurityCoverage,
  type AIScanFile,
  type AIScanResult,
  type AISecuritySignalState,
} from "@lyrashield/security/ai-security"
import { scanAiDataExposure, type AiDataExposureFinding } from "@lyrashield/security"
import { discoverWebMcpTools } from "@lyrashield/security/webmcp/discover"
import { evaluateWebMcpSurface } from "@lyrashield/security/webmcp"
import {
  WEBMCP_CONTROLS_BY_ID,
  type WebMcpBehavior,
  type WebMcpCoverageReceipt as SecurityWebMcpCoverageReceipt,
  type WebMcpDefinitionKind,
  type WebMcpSignal,
} from "@lyrashield/security/webmcp"
import { queryOsvWithCache, type AdvisoryBatchResult, type OsvQueryResult } from "@lyrashield/db"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import { resolveExactDependencies, type ResolvedDependencyInventory } from "./resolved-dependencies"
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_WALL_TIME_MS,
  MAX_WALK_ENTRIES,
  MAX_WALK_DEPTH,
  collectSourceFiles,
  resolveAiAppSecurityDiscoveryMode,
  throwIfAborted,
  type AiAppSecurityDiscoveryReceipt,
} from "./ai-app-source-discovery"
import {
  collectDependencyPackages,
  toDependencyResolution,
  type DependencyResolution,
} from "./ai-app-dependencies"

export type { AiAppSecurityDiscoveryReceipt } from "./ai-app-source-discovery"

interface AiAppSecurityScanConfig {
  repoPath: string
  workspaceDir: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
  dependencyInventory?: ResolvedDependencyInventory
  advisoryBatch?: AdvisoryBatchResult
  mode?: string
}

export interface WebMcpCoverageReceipt extends SecurityWebMcpCoverageReceipt {
  toolCounts: {
    byKind: Record<WebMcpDefinitionKind, number>
    byBehavior: Record<WebMcpBehavior, number>
  }
  exposurePosture: {
    dynamic: number
    wildcard: number
    explicitSelf: number
    explicitTrusted: number
    missingOrUnknown: number
  }
  confirmationPosture: {
    mutationTools: number
    unconfirmedMutations: number
  }
  methodology: string[]
}

export interface AiAppSecurityScanResult {
  findings: EngineVulnerability[]
  aiScanResult: AIScanResult
  ai03AdvisoryFresh: boolean
  ai03Coverage: Ai03CoverageReceipt
  discovery: AiAppSecurityDiscoveryReceipt
  webMcpFindings: EngineVulnerability[]
  webMcpCoverage: WebMcpCoverageReceipt | null
}

interface Ai03CoverageReceipt {
  state: AISecuritySignalState
  advisoryStatus: AdvisoryBatchResult["status"]
  resolutionStatus: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
  fresh: boolean
  source: "OSV"
  snapshotId: string | null
  snapshotChecksum: string | null
  fetchedAt: string | null
  requestedPackages: number
  resolvedPackages: number
  unresolvedReasons: string[]
}

function toAdvisoryVulnerabilities(result: OsvQueryResult): EngineVulnerability[] {
  const control = AI_SECURITY_CONTROLS_BY_ID["AI-03"]
  const packageRef = `${result.package.name}@${result.package.version}`
  return result.vulns.map((vuln) => {
    const fixedVersion = (
      vuln.affected?.flatMap(
        (affected) => affected.ranges?.flatMap((range) => range.events) ?? []
      ) ?? []
    )
      .filter((event): event is { fixed: string } => event.fixed !== undefined)
      .map((event) => event.fixed)
      .sort()[0]
    return {
      id: vuln.id,
      title: control?.title ?? `AI-03: Dependency advisory in ${packageRef}`,
      severity: "HIGH",
      timestamp: new Date().toISOString(),
      target: packageRef,
      finding_class: "dependency_advisory",
      dependency_metadata: {
        package_name: result.package.name,
        installed_version: result.package.version,
        package_ecosystem: result.package.ecosystem.toLowerCase(),
      },
      description: control?.description,
      evidence: `dependency lockfile: ${result.package.filePath} — ${packageRef}`,
      technical_analysis: `${packageRef} is affected by ${vuln.id}. ${vuln.summary ?? ""}`,
      remediation_steps: fixedVersion
        ? `Upgrade ${result.package.name} to ${fixedVersion} or later. Update the dependency in ${result.package.filePath}.`
        : `Review ${vuln.id} for ${packageRef} and consider replacing the dependency or applying a workaround.`,
      scannerSource: "ai_app_security" as const,
    }
  })
}

function toEngineVulnerability(
  signal: import("@lyrashield/security/ai-security").AISecuritySignal
): EngineVulnerability {
  const control = AI_SECURITY_CONTROLS_BY_ID[signal.controlId]
  const remediation =
    signal.remediation ?? control?.remediationTemplate ?? "Review the finding and remediate."
  const evidence = signal.snippet
    ? `${signal.file}:${signal.line}: ${signal.snippet}`
    : signal.evidenceSource

  return {
    id: signal.controlId,
    title: `${signal.controlId}: ${control?.title ?? signal.state}`,
    severity: signal.severity,
    timestamp: new Date().toISOString(),
    description: control?.description,
    evidence,
    technical_analysis: `${signal.controlId} (${signal.ruleId}) is ${signal.state} in ${signal.file}${signal.line ? ` at line ${signal.line}` : ""}. ${remediation}`,
    remediation_steps: remediation,
    scannerSource: "ai_app_security" as const,
  }
}

function toAiDataExposureVulnerability(
  finding: AiDataExposureFinding,
  file: string
): EngineVulnerability {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    timestamp: new Date().toISOString(),
    target: file,
    cwe: finding.cwe,
    description: finding.description,
    remediation_steps: finding.remediation,
    control_ids: finding.controlIds,
    code_locations: [
      {
        file,
        start_line: finding.line,
        end_line: finding.line,
        snippet: finding.snippet,
      },
    ],
    scannerSource: "ai_app_security" as const,
  }
}

function toWebMcpEngineVulnerability(signal: WebMcpSignal): EngineVulnerability {
  const control = WEBMCP_CONTROLS_BY_ID[signal.controlId]
  const remediation =
    signal.remediation ??
    control?.remediationTemplate ??
    "Review the WebMCP tool surface and remediate."
  const evidence = signal.snippet
    ? `${signal.file}:${signal.line}: ${signal.snippet}`
    : `${signal.file}${signal.line ? `:${signal.line}` : ""}`

  return {
    id: signal.controlId,
    title: control?.title ?? `${signal.controlId}: ${signal.state}`,
    severity: signal.severity,
    timestamp: new Date().toISOString(),
    target: signal.file,
    cwe: "CWE-749",
    finding_class: "webmcp_tool_surface",
    description: control?.description,
    evidence,
    technical_analysis: `${signal.controlId} (${signal.ruleId}) is ${signal.state} in ${signal.file}${signal.line ? ` at line ${signal.line}` : ""}. ${remediation}`,
    remediation_steps: remediation,
    code_locations:
      signal.file && signal.line
        ? [
            {
              file: signal.file,
              start_line: signal.line,
              end_line: signal.endLine ?? signal.line,
              snippet: signal.snippet,
            },
          ]
        : undefined,
    scannerSource: "ai_app_security" as const,
  }
}

function buildWebMcpCoverageReceipt(
  files: AIScanFile[],
  inventory: import("@lyrashield/security/webmcp").WebMcpToolInventory,
  signals: WebMcpSignal[],
  discovery: AiAppSecurityDiscoveryReceipt
): WebMcpCoverageReceipt {
  const definitions = inventory.definitions
  const kindCounts: Record<WebMcpDefinitionKind, number> = {
    imperative: definitions.filter((d) => d.kind === "imperative").length,
    declarative: definitions.filter((d) => d.kind === "declarative").length,
  }
  const behaviorCounts: Record<WebMcpBehavior, number> = {
    read: 0,
    "ui-only": 0,
    mutation: 0,
    unknown: 0,
  }
  for (const d of definitions) {
    behaviorCounts[d.behavior]++
  }

  const posture = {
    dynamic: 0,
    wildcard: 0,
    explicitSelf: 0,
    explicitTrusted: 0,
    missingOrUnknown: 0,
  }
  for (const d of definitions) {
    if (d.exposedTo === "dynamic") {
      posture.dynamic++
    } else if (Array.isArray(d.exposedTo)) {
      const hasWildcard = d.exposedTo.some((o) => o === "*" || o.includes("*"))
      const hasSelf = d.exposedTo.some((o) => o.includes("self"))
      if (hasWildcard) {
        posture.wildcard++
      } else if (hasSelf) {
        posture.explicitSelf++
      } else if (d.exposedTo.length > 0) {
        posture.explicitTrusted++
      } else {
        posture.missingOrUnknown++
      }
    } else {
      posture.missingOrUnknown++
    }
  }

  const confirmation = {
    mutationTools: definitions.filter((d) => d.behavior === "mutation").length,
    unconfirmedMutations: signals.filter(
      (s) => s.controlId === "WEBMCP-05" && s.state === "DETECTED"
    ).length,
  }

  const structurallyIncomplete = definitions.filter(
    (d) =>
      d.name === null ||
      d.behavior === "unknown" ||
      d.inputSchema.type === "unknown" ||
      d.inputSchema.type === "any"
  ).length
  const incompleteDefinitions = Math.max(inventory.incompleteDefinitions, structurallyIncomplete)

  const eligibleFiles = Math.max(0, files.length - inventory.unsupportedFiles.length)
  const scannedFiles = Math.max(0, eligibleFiles - inventory.truncatedFiles.length)
  const unscannedPaths = new Set([...inventory.unsupportedFiles, ...inventory.truncatedFiles])
  const limitsReached = [...new Set([...discovery.limitsReached, ...inventory.limitsReached])]
  const coverageState =
    discovery.skippedFiles === 0 &&
    incompleteDefinitions === 0 &&
    inventory.truncatedFiles.length === 0 &&
    limitsReached.length === 0
      ? "COMPLETE"
      : "INCONCLUSIVE"

  return {
    version: "webmcp-assurance/1",
    detectorVersion: inventory.detectorVersion,
    coverageState,
    eligibleFiles,
    scannedFiles,
    scannedBytes: files.reduce(
      (total, file) => total + (unscannedPaths.has(file.path) ? 0 : file.size),
      0
    ),
    toolDefinitionsFound: definitions.length,
    toolDefinitionsAssessed: Math.max(0, definitions.length - structurallyIncomplete),
    incompleteDefinitions,
    imperativeDefinitions: kindCounts.imperative,
    declarativeDefinitions: kindCounts.declarative,
    limitsReached,
    inventoryChecksum: inventory.checksum,
    sourceSelection: {
      eligibleFiles: discovery.eligibleFiles,
      selectedFiles: discovery.scannedFiles,
      skippedFiles: discovery.skippedFiles,
      scannedBytes: discovery.scannedBytes,
      skippedByReason: { ...discovery.skippedByReason },
      limits: {
        maxFiles: discovery.maxFiles,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxWalkEntries: MAX_WALK_ENTRIES,
        maxWalkDepth: MAX_WALK_DEPTH,
      },
      limitsReached: [...discovery.limitsReached],
    },
    toolCounts: {
      byKind: kindCounts,
      byBehavior: behaviorCounts,
    },
    exposurePosture: posture,
    confirmationPosture: confirmation,
    methodology: [
      "WebMCP discovery runs over the same source files as AI App Security.",
      "The receipt contains bounded metadata only: no raw source, schemas, or workspace identifiers.",
      `WebMCP received ${discovery.scannedFiles} of ${discovery.eligibleFiles} repository-eligible files from outer source selection.`,
      `${eligibleFiles} selected file(s) were eligible for WebMCP analysis; unsupported source languages were excluded from the WebMCP scope.`,
      coverageState === "INCONCLUSIVE"
        ? "Coverage is INCONCLUSIVE because source selection or WebMCP discovery was incomplete."
        : "Outer source selection and WebMCP discovery completed without recorded limits.",
      incompleteDefinitions > 0
        ? `${incompleteDefinitions} tool definition(s) were incomplete and could not be fully assessed.`
        : "All discovered tool definitions had enough static structure to be assessed.",
    ],
  }
}

async function runWebMcpScan(
  files: AIScanFile[],
  discovery: AiAppSecurityDiscoveryReceipt,
  coverageIssues: ScannerCoverageIssue[],
  signal?: AbortSignal
): Promise<{ findings: EngineVulnerability[]; coverage: WebMcpCoverageReceipt | null }> {
  const scanFiles: import("@lyrashield/security/webmcp").WebMcpScanFile[] = files.map((file) => ({
    ...file,
    truncated: false,
  }))

  try {
    const { inventory, context } = await discoverWebMcpTools(scanFiles, {
      limits: {
        maxFiles: 1_000,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxWallTimeMs: MAX_WALL_TIME_MS,
        maxDefinitions: 500,
      },
      signal,
    })

    const signals = evaluateWebMcpSurface(scanFiles, inventory, context)
    const webMcpFindings: EngineVulnerability[] = []
    for (const signal of signals) {
      if (signal.state === "DETECTED") {
        webMcpFindings.push(toWebMcpEngineVulnerability(signal))
      }
    }

    if (inventory.limitsReached.length > 0) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "bounded",
        reason: `WebMCP discovery reached its limit: ${inventory.limitsReached.join(", ")}`,
        metadata: { webMcpLimits: inventory.limitsReached },
      })
    }

    if (inventory.incompleteDefinitions > 0 || inventory.truncatedFiles.length > 0) {
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        reason: "WebMCP discovery could not fully assess every eligible definition",
        metadata: {
          incompleteDefinitions: inventory.incompleteDefinitions,
          truncatedFiles: inventory.truncatedFiles.length,
        },
      })
    }

    const coverage = buildWebMcpCoverageReceipt(files, inventory, signals, discovery)
    return { findings: webMcpFindings, coverage }
  } catch (err) {
    logger.warn("WebMCP scan failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "partial",
      reason: "WebMCP discovery or evaluation failed",
      metadata: { error: err instanceof Error ? err.message : String(err) },
    })
    return { findings: [], coverage: null }
  }
}

export async function scanAiAppSecurity({
  repoPath,
  coverageIssues = [],
  signal,
  dependencyInventory,
  advisoryBatch: injectedAdvisoryBatch,
  mode: requestedMode,
}: AiAppSecurityScanConfig): Promise<AiAppSecurityScanResult> {
  logger.info("Starting AI App Security scan phase")
  throwIfAborted(signal)

  const mode = resolveAiAppSecurityDiscoveryMode(requestedMode)
  const { files, discovery } = await collectSourceFiles(repoPath, coverageIssues, mode, signal)
  if (files.length === 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "ai_app_security",
      status: "unsupported",
      reason: "No supported source files found for AI App Security scan",
    })
    const notAssessedControls = Object.fromEntries(
      AI_SECURITY_CONTROLS.map(
        (control) =>
          [
            control.id,
            {
              controlId: control.id,
              state: "NOT_ASSESSED",
              assessed: false,
              ruleIds: [],
              fileCount: 0,
              signalCount: 0,
            } satisfies AIScanResult["coverage"]["controls"][typeof control.id],
          ] as const
      )
    ) satisfies AIScanResult["coverage"]["controls"]

    return {
      findings: [],
      aiScanResult: {
        signals: [],
        coverage: {
          version: AI_SECURITY_DETECTOR_VERSION,
          totalControls: AI_SECURITY_CONTROLS.length,
          assessedCount: 0,
          notAssessedCount: AI_SECURITY_CONTROLS.length,
          detectedCount: 0,
          noFindingCount: 0,
          inconclusiveCount: 0,
          controls: notAssessedControls,
          limitsReached: discovery.limitsReached,
          unsupportedFiles: [],
          truncatedFiles: [],
        },
        provenance: {
          files: 0,
          bytes: 0,
          scannedAt: new Date().toISOString(),
          limitsReached: discovery.limitsReached,
          detectorVersion: AI_SECURITY_DETECTOR_VERSION,
        },
      },
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
        unresolvedReasons: ["No supported source files found"],
      },
      discovery,
      webMcpFindings: [],
      webMcpCoverage: null,
    }
  }

  const result = scanAiSecurityFiles(files, {
    limits: {
      maxFiles: discovery.maxFiles,
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      maxWallTimeMs: MAX_WALL_TIME_MS,
    },
  })
  result.coverage.limitsReached = [
    ...new Set([...result.coverage.limitsReached, ...discovery.limitsReached]),
  ]
  result.provenance.limitsReached = [
    ...new Set([...result.provenance.limitsReached, ...discovery.limitsReached]),
  ]

  const findings: EngineVulnerability[] = []
  for (const signal of result.signals) {
    if (signal.state === "DETECTED") {
      findings.push(toEngineVulnerability(signal))
    }
  }
  for (const file of files) {
    for (const exposure of scanAiDataExposure(file)) {
      findings.push(toAiDataExposureVulnerability(exposure, file.path))
    }
  }

  const { findings: webMcpFindings, coverage: webMcpCoverage } = await runWebMcpScan(
    files,
    discovery,
    coverageIssues,
    signal
  )
  findings.push(...webMcpFindings)

  throwIfAborted(signal)
  let dependencyResolution: DependencyResolution
  try {
    dependencyResolution = dependencyInventory
      ? toDependencyResolution(dependencyInventory)
      : toDependencyResolution(await resolveExactDependencies({ repoPath, coverageIssues, signal }))
  } catch (error) {
    logger.warn("Exact AI-03 dependency resolution failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    // The legacy parser is retained only to identify potentially affected
    // packages for an inconclusive result. A resolver failure must never turn
    // into a clean AI-03 outcome, even when the fallback sees exact versions.
    const fallback = await collectDependencyPackages(repoPath, coverageIssues, signal)
    dependencyResolution = {
      ...fallback,
      status: "PARTIAL",
      unresolvedReasons: [
        ...fallback.unresolvedReasons,
        "Exact dependency resolver failed; advisory coverage is inconclusive",
      ],
    }
  }
  let advisoryBatch: AdvisoryBatchResult = {
    status: "UNAVAILABLE",
    source: "OSV",
    requestedCount: 0,
    resolvedCount: 0,
    results: [],
    fetchedAt: null,
    snapshotId: null,
    snapshotChecksum: null,
    cacheAgeSeconds: null,
    supportedEcosystems: [],
    unresolved: [],
  }
  if (injectedAdvisoryBatch) {
    advisoryBatch = injectedAdvisoryBatch
  } else if (dependencyResolution.packages.length > 0) {
    logger.info("AI App Security dependency advisory scan starting", {
      packageCount: dependencyResolution.packages.length,
    })
    try {
      advisoryBatch = await queryOsvWithCache(dependencyResolution.packages)

      for (const advisory of advisoryBatch.results) {
        if (advisory.vulns.length > 0) {
          findings.push(...toAdvisoryVulnerabilities(advisory))
          result.signals.push(
            buildSignal(
              "AI-03",
              "AI-03.osv-advisory",
              "DETECTED",
              dependencyResolution.evidenceFile,
              {
                evidenceSource: "advisory",
                overrideSeverity: "MEDIUM",
                overrideRemediation: `Upgrade ${advisory.package.name} to a patched version or replace the dependency.`,
              }
            )
          )
        }
      }
    } catch (err) {
      logger.warn("AI App Security dependency advisory scan failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      recordCoverageIssue(coverageIssues, {
        scanner: "ai_app_security",
        status: "partial",
        reason: "AI-03 dependency advisory query failed",
      })
    }
  }

  const ai03Complete =
    dependencyResolution.status === "COMPLETE" && advisoryBatch.status === "COMPLETE"
  const ai03Coverage: Ai03CoverageReceipt = {
    state: advisoryBatch.results.some((entry) => entry.vulns.length > 0)
      ? "DETECTED"
      : ai03Complete
        ? "NO_FINDING"
        : "INCONCLUSIVE",
    advisoryStatus: advisoryBatch.status,
    resolutionStatus: dependencyResolution.status,
    fresh: ai03Complete,
    source: "OSV",
    snapshotId: advisoryBatch.snapshotId,
    snapshotChecksum: advisoryBatch.snapshotChecksum,
    fetchedAt: advisoryBatch.fetchedAt,
    requestedPackages: dependencyResolution.packages.length,
    resolvedPackages: advisoryBatch.resolvedCount,
    unresolvedReasons: [
      ...dependencyResolution.unresolvedReasons,
      ...advisoryBatch.unresolved.map(
        (entry) => `${entry.ecosystem}:${entry.name}: ${entry.reason}`
      ),
    ],
  }
  if (ai03Coverage.state !== "NO_FINDING" && ai03Coverage.state !== "DETECTED") {
    result.signals.push(
      buildSignal(
        "AI-03",
        "AI-03.osv-coverage",
        ai03Coverage.state,
        dependencyResolution.evidenceFile,
        {
          evidenceSource: "advisory",
          overrideRemediation:
            ai03Coverage.unresolvedReasons.join("; ") || "AI-03 could not be assessed",
        }
      )
    )
  }

  result.coverage = {
    ...result.coverage,
    ...summarizeAiSecurityCoverage(
      result.signals,
      AI_SECURITY_CONTROLS.map((c) => c.id),
      {
        limitsReached: result.coverage.limitsReached,
        unsupportedFiles: result.coverage.unsupportedFiles,
        truncatedFiles: result.coverage.truncatedFiles,
      }
    ),
  }

  const detectedCount = result.signals.filter((s) => s.state === "DETECTED").length
  logger.info("AI App Security scan phase complete", {
    fileCount: files.length,
    signalCount: result.signals.length,
    detectedCount,
    advisoryFindings: findings.length - detectedCount,
  })

  return {
    findings,
    aiScanResult: result,
    ai03AdvisoryFresh: ai03Coverage.fresh,
    ai03Coverage,
    discovery,
    webMcpFindings,
    webMcpCoverage,
  }
}
