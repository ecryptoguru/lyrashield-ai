import {
  parseEngineCoverage,
  parseHttpExchangeExport,
  parseThreatModels,
} from "./output-parser-artifacts"
import { parseVulnerabilitiesArtifact } from "./output-parser-findings"
import { parseRunJson } from "./output-parser-run"
import type { EngineArtifactInput, ParsedScanOutput } from "./output-parser-types"

export type {
  AdvisoryCvss,
  EngineArtifactInput,
  EngineCoverageGap,
  EngineMetadataValue,
  EngineRunRecord,
  EngineVulnerability,
  FindingRevision,
  FixVerificationAttestation,
  ParsedEngineCoverage,
  ParsedHttpExchangeExport,
  ParsedScanOutput,
  ParsedThreatModelEntry,
  ParsedThreatModels,
  ScopedCoverageEntry,
  ScopedCoverageOutcome,
} from "./output-parser-types"
export { buildFindingSummary, generateDedupeKey, mapSeverity } from "./output-parser-findings"
export { mergeLlmUsage, parseRunJson } from "./output-parser-run"

export function parseEngineOutput(
  vulnerabilitiesRaw: string,
  runJsonRaw: string,
  artifacts?: EngineArtifactInput
): ParsedScanOutput {
  const ingestionIssues: string[] = []
  const httpExchangeExport = parseHttpExchangeExport(artifacts?.httpExchangesRaw, ingestionIssues)
  // `undefined` means this caller supplied no exchange context at all (e.g.
  // unit tests of the standalone parser): declared refs are carried but never
  // trusted. `null` means the export is absent or unreadable — declared refs
  // are omitted and a warning is recorded.
  const knownExchangeIds =
    artifacts === undefined ? undefined : (httpExchangeExport?.knownIds ?? null)
  const parsedVulnerabilities = parseVulnerabilitiesArtifact(vulnerabilitiesRaw, {
    issues: ingestionIssues,
    httpExchangeIds: knownExchangeIds,
  })
  const vulnerabilities = parsedVulnerabilities.vulnerabilities
  const runRecord = parseRunJson(runJsonRaw)
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
