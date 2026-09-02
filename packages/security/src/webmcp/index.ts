export { WEBMCP_CONTROLS, WEBMCP_CONTROLS_BY_ID, WEBMCP_CONTROL_IDS } from "./controls"

export { buildCanonicalInput, computeDefinitionHash, computeInventoryHash } from "./canonicalize"

export { sha256, sha256Sync } from "./hash"

export { evaluateWebMcpSurface, summarizeWebMcpCoverage } from "./evaluate"

export { applyWebMcpRewrite, generateWebMcpDiff } from "./text-edits"

export {
  computeEvidenceChecksum,
  getLineNumber,
  getLineAt,
  getSnippet,
  buildSignal,
  detectedSignal,
  noFindingSignal,
  inconclusiveSignal,
  notAssessedSignal,
  isProtectiveWording,
} from "./utils"

export type {
  WebMcpDefinitionKind,
  WebMcpBehavior,
  WebMcpEvidenceState,
  WebMcpSeverity,
  WebMcpEvidenceSource,
  WebMcpRuntimeValidation,
  WebMcpScanLimit,
  WebMcpControlId,
  WebMcpScanFile,
  WebMcpSchemaProperty,
  NormalizedSchemaSummary,
  WebMcpToolSurface,
  WebMcpToolInventory,
  WebMcpCoverageReceipt,
  WebMcpSignal,
  WebMcpControlDefinition,
  WebMcpControlCoverage,
  WebMcpCoverageSummary,
  WebMcpScanResult,
  WebMcpDiscoveryOptions,
  WebMcpTextEdit,
  WebMcpRewritePlan,
  WebMcpEvaluateContext,
  WebMcpEvidenceLocation,
  WebMcpSpecDriftFinding,
} from "./types"

export { WEBMCP_DETECTOR_VERSION } from "./types"
