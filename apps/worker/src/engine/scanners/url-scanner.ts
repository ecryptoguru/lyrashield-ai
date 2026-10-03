import { logger } from "@lyrashield/logger"
import {
  collectPublicSurface,
  analyzePublicSurface,
  isDetectedSignal,
  redactUrlForLogs,
  type SurfaceCollection,
  type SurfaceCollectionIssue,
} from "@lyrashield/security"
import {
  getUrlScanProfile,
  type UrlScanProfile,
  type UrlExecutionSummary,
  type UrlRequestMethod,
} from "@lyrashield/types"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import { runUrlBehaviorProbes } from "./url-behavior-probes"
import { toEngineVulnerability } from "./openapi-scanner-support"

interface UrlScanConfig {
  targetUrl: string
  profile?: UrlScanProfile
  fetchFn?: typeof fetch
  /** Injectable DNS resolver — only for tests. */
  resolver?: import("@lyrashield/security").HostResolver
  signal?: AbortSignal
  coverageIssues?: ScannerCoverageIssue[]
  /** OpenAPI document URL for API Contract/Behavior scans. */
  apiSpecUrl?: string | null
}

type UrlScannerResult = {
  findings: EngineVulnerability[]
  execution: UrlExecutionSummary
  issues: SurfaceCollectionIssue[]
}

function buildExecution(
  collection: SurfaceCollection,
  methodProbes = 0,
  originProbes = 0
): UrlExecutionSummary {
  const subjects = collection.subjects
  return {
    contractVersion: collection.contractVersion,
    profile: collection.profile.id,
    methods: [...new Set(collection.profile.allowedMethods)].sort() as UrlRequestMethod[],
    subjectCount: subjects.length,
    documentCount: subjects.filter((s) => s.kind === "document").length,
    assetCount: subjects.filter((s) => s.kind === "asset").length,
    operationCount: subjects.filter((s) => s.kind === "api_operation").length,
    methodProbeCount: methodProbes,
    originProbeCount: originProbes,
    totalBytes: collection.totalBytes,
    truncated: collection.truncated,
    issueCodes: [...new Set(collection.issues.map((i) => i.code))].sort(),
  }
}

export async function scanUrl(config: UrlScanConfig): Promise<UrlScannerResult> {
  const { targetUrl, fetchFn, resolver, coverageIssues, signal } = config
  logger.info("Starting AI-builder-aware URL scan", { targetUrl: redactUrlForLogs(targetUrl) })

  const profile = config.profile ?? getUrlScanProfile("WEB_APP", "SAFE")
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

  let methodProbes = 0
  let originProbes = 0

  if (profile.id === "WEB_APP_DEEP") {
    const probeResult = await runUrlBehaviorProbes({
      collection,
      fetchFn,
      resolver,
      signal,
    })

    collection.subjects.push(...probeResult.subjects)
    collection.issues.push(...probeResult.issues)
    for (const signal of probeResult.signals) {
      if (!signals.find((s) => s.id === signal.id)) {
        signals.push(signal)
      }
    }
    methodProbes = probeResult.subjects.filter(
      (s) => s.method === "HEAD" || s.method === "OPTIONS"
    ).length
    originProbes = probeResult.subjects.filter((s) => s.method === "GET").length
  }

  const findings = signals.filter(isDetectedSignal).map(toEngineVulnerability)

  logger.info("URL scan complete", {
    targetUrl: redactUrlForLogs(targetUrl),
    findings: findings.length,
  })
  return {
    findings,
    execution: buildExecution(collection, methodProbes, originProbes),
    issues: collection.issues,
  }
}
