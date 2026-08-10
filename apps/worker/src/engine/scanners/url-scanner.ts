import { logger } from "@lyrashield/logger"
import {
  collectPublicSurface,
  analyzePublicSurface,
  isDetectedSignal,
  redactUrlForLogs,
  type SurfaceCollection,
  type SurfaceCollectionIssue,
  type SurfaceSignal,
} from "@lyrashield/security"
import { getUrlScanProfile } from "@lyrashield/types"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

export interface UrlScanConfig {
  targetUrl: string
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: import("@lyrashield/security").HostResolver
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
}

export type UrlRequestMethod = "GET" | "HEAD" | "OPTIONS"

export type UrlExecutionSummary = {
  contractVersion: string
  profile: string
  methods: UrlRequestMethod[]
  subjectCount: number
  totalBytes: number
  truncated: boolean
  issues: SurfaceCollectionIssue[]
}

export type UrlScannerResult = {
  findings: EngineVulnerability[]
  execution: UrlExecutionSummary
  issues: SurfaceCollectionIssue[]
}

function controlToCwe(controlId: number | undefined): string {
  switch (controlId) {
    case 3:
      return "CWE-798"
    case 27:
      return "CWE-693"
    case 28:
      return "CWE-614"
    case 29:
      return "CWE-319"
    case 31:
      return "CWE-209"
    case 32:
      return "CWE-540"
    default:
      return "CWE-693"
  }
}

function toEngineVulnerability(signal: SurfaceSignal): EngineVulnerability {
  const controlId = signal.controlIds[0]
  return {
    id: signal.id,
    title: signal.title,
    severity: (signal.severity ?? "MEDIUM").toLowerCase(),
    timestamp: new Date().toISOString(),
    cwe: controlToCwe(controlId),
    description: signal.description,
    remediation_steps: signal.remediation,
    control_ids: [...signal.controlIds],
    target: signal.subjectUrl,
    endpoint: signal.subjectUrl,
    evidence: JSON.stringify(signal.evidence),
  }
}

function buildExecution(collection: SurfaceCollection): UrlExecutionSummary {
  return {
    contractVersion: collection.contractVersion,
    profile: collection.profile.id,
    methods: collection.profile.allowedMethods as UrlRequestMethod[],
    subjectCount: collection.subjects.length,
    totalBytes: collection.totalBytes,
    truncated: collection.truncated,
    issues: collection.issues,
  }
}

export async function scanUrl(config: UrlScanConfig): Promise<UrlScannerResult> {
  const { targetUrl, fetchFn, resolver, coverageIssues, signal } = config
  logger.info("Starting AI-builder-aware URL scan", { targetUrl: redactUrlForLogs(targetUrl) })

  const profile = getUrlScanProfile("WEB_APP", "SAFE")
  const collection = await collectPublicSurface({
    seedUrl: targetUrl,
    profile,
    userAgent: "LyraShield-Worker/2.0",
    fetchFn,
    resolver,
    signal,
  })

  const document = collection.subjects.find((subject) => subject.kind === "document")
  if (!document) {
    const fetchFailed = collection.issues.find((issue) => issue.code === "FETCH_FAILED")
    const reason = fetchFailed ? fetchFailed.reason : "the target could not be reached"
    logger.warn("URL scan skipped — could not fetch target", {
      targetUrl: redactUrlForLogs(targetUrl),
      reason,
    })
    recordCoverageIssue(coverageIssues, {
      scanner: "url",
      status: "partial",
      subject: redactUrlForLogs(targetUrl),
      reason: `URL content could not be fetched: ${reason}`,
    })
    return {
      findings: [],
      execution: buildExecution(collection),
      issues: collection.issues,
    }
  }

  const signals = analyzePublicSurface(collection)
  const findings = signals.filter(isDetectedSignal).map(toEngineVulnerability)

  logger.info("URL scan complete", {
    targetUrl: redactUrlForLogs(targetUrl),
    findings: findings.length,
  })
  return {
    findings,
    execution: buildExecution(collection),
    issues: collection.issues,
  }
}
