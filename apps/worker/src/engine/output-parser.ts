import {
  parseEngineCoverage,
  parseHttpExchangeExport,
  retainCapturedHttpExchanges,
  parseThreatModels,
} from "./output-parser-artifacts"
import { bindHttpExchangeEvidence } from "./output-parser-evidence"
import { recordIngestionIssue } from "./output-parser-common"
import { parseVulnerabilitiesArtifact } from "./output-parser-findings"
import { parseRunJson } from "./output-parser-run"
import type { EngineArtifactInput, ParsedScanOutput } from "./output-parser-types"

export type {
  EngineArtifactInput,
  EngineCoverageGap,
  EngineRunRecord,
  EngineVulnerability,
  ParsedEngineCoverage,
  ParsedScanOutput,
  ScopedCoverageEntry,
  ScopedCoverageOutcome,
} from "./output-parser-types"
export { buildFindingSummary, generateDedupeKey, mapSeverity } from "./output-parser-findings"
export { mergeLlmUsage, parseRunJson } from "./output-parser-run"

export function parseEngineOutput(
  vulnerabilitiesRaw: string,
  runJsonRaw: string,
  artifacts?: EngineArtifactInput,
  context?: { expectedRunName: string }
): ParsedScanOutput {
  const ingestionIssues: string[] = []
  const runRecord = parseRunJson(runJsonRaw)
  // The launcher supplies --run-name. The owned initial_run_record contract
  // uses that name for both run_id and run_name (UUIDs apply only without it).
  // Reject the whole foreign bundle before downstream persistence.
  if (
    context &&
    (runRecord?.run_name !== context.expectedRunName ||
      runRecord.run_id !== context.expectedRunName)
  ) {
    return {
      vulnerabilities: [],
      runRecord: null,
      summary: "Engine output rejected: run identity unavailable or mismatched.",
      findingCount: 0,
      findingsComplete: false,
      ingestionIssues: [
        "Engine output run_id/run_name does not match the launched run — artifacts rejected",
      ],
      scopedCoverage: null,
      threatModels: null,
      httpExchangeExport: null,
    }
  }
  const parsedHttpExchangeExport = parseHttpExchangeExport(
    artifacts?.httpExchangesRaw,
    ingestionIssues
  )
  const httpExchangeBinding = bindHttpExchangeEvidence(
    runRecord,
    runJsonRaw,
    vulnerabilitiesRaw,
    artifacts?.httpExchangesRaw,
    parsedHttpExchangeExport
  )
  // `undefined` means this caller supplied no exchange context at all (e.g.
  // unit tests of the standalone parser): declared refs are carried but never
  // trusted. `null` means the export is absent or unreadable — declared refs
  // are omitted and a warning is recorded.
  const knownExchangeIds =
    artifacts === undefined ? undefined : (parsedHttpExchangeExport?.knownIds ?? null)
  const parsedVulnerabilities = parseVulnerabilitiesArtifact(vulnerabilitiesRaw, {
    issues: ingestionIssues,
    httpExchangeIds: knownExchangeIds,
    httpExchangeRequestHosts: parsedHttpExchangeExport?.requestHosts,
    httpExchangeExcludedIds: new Set([
      ...(parsedHttpExchangeExport?.excludedIds ?? []),
      ...(runRecord?.evidence_export?.missing_request_ids ?? []),
      ...(runRecord?.evidence_export?.capacity_omitted_request_ids ?? []),
    ]),
    httpExchangeBinding,
  })
  const vulnerabilities = parsedVulnerabilities.vulnerabilities
  const requiresQualifiedExport =
    httpExchangeBinding !== undefined ||
    parsedHttpExchangeExport?.binding?.finding_revisions !== undefined ||
    vulnerabilities.some((finding) => finding.evidence_contract_version === "1.2")
  let httpExchangeExport = parsedHttpExchangeExport
  if (requiresQualifiedExport && parsedHttpExchangeExport) {
    const acceptedOwners = new Set(vulnerabilities.map((finding) => finding.id))
    const ownedCaptures = new Set(
      vulnerabilities.flatMap((finding) => finding.http_exchange_ids ?? [])
    )
    if (
      !httpExchangeBinding ||
      Object.keys(httpExchangeBinding.findings ?? {}).some((id) => !acceptedOwners.has(id)) ||
      [...parsedHttpExchangeExport.knownIds].some((id) => !ownedCaptures.has(id))
    ) {
      httpExchangeExport = null
      recordIngestionIssue(
        ingestionIssues,
        "http_exchanges.json lacks a qualified 1.2 run/manifest/finding capture binding — artifact quarantined"
      )
    }
  }
  if (requiresQualifiedExport) {
    for (const finding of vulnerabilities) {
      if (!finding.http_exchange_ids?.length) continue
      const captures = finding.http_exchange_ids.filter(
        (id) => !finding.pending_http_exchange_ids?.includes(id)
      )
      if (captures.length !== finding.http_exchange_ids.length) {
        recordIngestionIssue(
          ingestionIssues,
          `finding ${finding.id}: pending and captured HTTP IDs overlap — pending takes precedence`
        )
      }
      if (httpExchangeExport && captures.length === finding.http_exchange_ids.length) continue
      finding.http_exchange_refs_dropped = true
      if (httpExchangeExport && captures.length) finding.http_exchange_ids = captures
      else delete finding.http_exchange_ids
    }
    if (httpExchangeExport) {
      const capturedIds = new Set(
        vulnerabilities.flatMap((finding) => finding.http_exchange_ids ?? [])
      )
      httpExchangeExport = retainCapturedHttpExchanges(httpExchangeExport, capturedIds)
    }
  }
  const scopedCoverage = parseEngineCoverage(artifacts?.coverageRaw, ingestionIssues)
  const threatModels = parseThreatModels(
    artifacts?.threatModelsRaw,
    ingestionIssues,
    runRecord?.run_id
  )

  const summary = runRecord?.status
    ? `Engine status: ${runRecord.status}. ${vulnerabilities.length} finding(s) reported.`
    : `Scan completed. ${vulnerabilities.length} finding(s) reported.`

  return {
    vulnerabilities,
    runRecord,
    summary,
    findingCount: vulnerabilities.length,
    findingsComplete: parsedVulnerabilities.complete,
    ingestionIssues,
    scopedCoverage,
    threatModels,
    httpExchangeExport,
  }
}
