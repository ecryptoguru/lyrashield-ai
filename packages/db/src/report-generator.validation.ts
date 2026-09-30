import { VIBE_SECURITY_CONTROLS } from "@lyrashield/security"
import {
  WEBMCP_CONTROLS,
  WEBMCP_CONTROL_IDS,
  type WebMcpControlId,
  type WebMcpCoverageReceipt,
  type WebMcpSeverity,
} from "@lyrashield/security/webmcp"

export const CONTROL_TITLE_BY_ID: Record<string, string> = Object.fromEntries(
  VIBE_SECURITY_CONTROLS.map((control) => [`vibe-${control.rank}`, control.title])
)

const WEBMCP_CONTROL_ID_BY_TITLE = new Map(
  WEBMCP_CONTROLS.map((control) => [control.title, control.id] as const)
)

export interface ReportData {
  version?: 2 | 3
  audience?: "developer" | "executive" | "compliance"
  title: string
  type: string
  workspaceName: string
  scanInfo: {
    scanId: string
    targetId?: string | null
    goal?: string
    mode?: string
    status: string
    summary: string | null
    targetName: string
    targetType: string
    targetUrl: string | null
    startedAt: Date | null
    endedAt: Date | null
    manifestChecksum: string | null
    coverage: { completed: number; limited: number; notApplicable: number }
    /** Per-scan standards matrix — the five defaultSurface standards rendered
     * from this scan's coverage receipts and findings. */
    standards?: import("@lyrashield/security").StandardView[]
    urlExecution?: {
      profile: string
      methods: string[]
      subjectCount: number
      documentCount: number
      assetCount: number
      operationCount: number
      methodProbeCount: number
      originProbeCount: number
      totalBytes: number
      truncated: boolean
      issueCodes: string[]
    }
  } | null
  findings: Array<{
    id: string
    title: string
    severity: string
    status: string
    verified: boolean
    verificationStatus?: string
    confidence: string
    cwe: string | null
    cvssScore: number | null
    category: string | null
    summary: string
    exploitability: string | null
    recommendedFix: string | null
    fixStatus: string
    retestStatus: string | null
  }>
  findingsBySeverity: Record<string, number>
  findingsByStatus?: Record<string, number>
  findingsByCategory?: Record<string, number>
  totalFindings: number
  verifiedCount: number
  fixedCount: number
  retestSummary: { passed: number; failed: number; pending: number }
  findingsTruncated: boolean
  generatedAt: Date
  assurance?: {
    verdict: "NOT_EVALUATED" | "GO" | "GO_WITH_CONDITIONS" | "NO_GO"
    score: number | null
    grade: string | null
    narrative: string
    scoreTrend: Array<{ score: number; grade: string; computedAt: Date }>
    ageBuckets: Record<string, number>
    priorityActions: Array<{ label: string; detail: string; severity: string }>
    methodology: string[]
  }
  aiAssurance?: {
    version: "ai-assurance/1.0.0"
    profileState: "COMPLETE" | "INCOMPLETE" | "NOT_ASSESSED"
    threatModelState: "CURRENT" | "MISSING" | "NOT_ASSESSED"
    evidence: Array<{
      controlId: string
      state: string
      evidenceVersionId: string | null
      expiresAt: Date | null
    }>
    frameworkVersion: string
    controls: Array<{
      controlId: string
      controlTitle: string
      state: string
      status: string | null
      version: number | null
      attestation: string | null
      expiresAt: Date | null
      reviewedById: string | null
      reviewedAt: Date | null
      artifacts: Array<{
        filename: string
        mediaType: string
        byteLength: number
        checksum: string
      }>
    }>
    generatedAt: Date
    methodology: string[]
  }
  aiAppSecurity?: {
    score: number | null
    methodology: string | null
    assessedCount: number | null
    totalControls: number | null
    reason: string | null
    generatedAt: Date
    methodologyWording: string[]
  }
  webMcpAssurance?: ReportWebMcpAssurance
}

export interface ReportWebMcpAssurance extends WebMcpCoverageReceipt {
  coverageState: "COMPLETE" | "INCONCLUSIVE"
  toolCounts: {
    byKind: Record<string, number>
    byBehavior: Record<string, number>
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
  findingsByControl: Record<WebMcpControlId, number>
  findingsBySeverity: Record<WebMcpSeverity, number>
  representativeRemediation: Array<{
    controlId: WebMcpControlId
    severity: WebMcpSeverity
    text: string
  }>
  methodology: string[]
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isDateValue(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isNullableDateValue(value: unknown): boolean {
  return value === null || isDateValue(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isCountRecord(value: unknown, allowedKeys?: readonly string[]): boolean {
  return (
    isObjectRecord(value) &&
    Object.entries(value).every(
      ([key, count]) =>
        (allowedKeys === undefined || allowedKeys.includes(key)) && nonnegativeNumber(count)
    )
  )
}

function isReportFinding(value: unknown): boolean {
  if (!isObjectRecord(value)) return false
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
  const statuses = [
    "OPEN",
    "FIX_READY",
    "PR_OPENED",
    "TICKET_CREATED",
    "FIXED_PENDING_RETEST",
    "FIXED",
    "ACCEPTED_RISK",
    "FALSE_POSITIVE",
    "DUPLICATE",
  ]
  return (
    isString(value.id) &&
    isString(value.title) &&
    typeof value.severity === "string" &&
    severities.includes(value.severity) &&
    typeof value.status === "string" &&
    statuses.includes(value.status) &&
    typeof value.verified === "boolean" &&
    isString(value.confidence) &&
    isNullableString(value.cwe) &&
    (value.cvssScore === null ||
      (typeof value.cvssScore === "number" && Number.isFinite(value.cvssScore))) &&
    isNullableString(value.category) &&
    isString(value.summary) &&
    isNullableString(value.exploitability) &&
    isNullableString(value.recommendedFix) &&
    isString(value.fixStatus) &&
    isNullableString(value.retestStatus) &&
    (value.verificationStatus === undefined || isString(value.verificationStatus))
  )
}

function isReportScanInfo(value: unknown, allowV2MissingIdentityFields: boolean): boolean {
  if (value === null) return true
  if (!isObjectRecord(value)) return false
  const coverage = value.coverage
  const urlExecution = value.urlExecution
  const standards = value.standards
  const isMissingV2Field = (field: "targetId" | "goal" | "mode") =>
    allowV2MissingIdentityFields && !Object.prototype.hasOwnProperty.call(value, field)
  return (
    isString(value.scanId) &&
    (isMissingV2Field("targetId") || isNullableString(value.targetId)) &&
    (isMissingV2Field("goal") || isString(value.goal)) &&
    (isMissingV2Field("mode") || isString(value.mode)) &&
    isString(value.status) &&
    isNullableString(value.summary) &&
    isString(value.targetName) &&
    isString(value.targetType) &&
    isNullableString(value.targetUrl) &&
    isNullableDateValue(value.startedAt) &&
    isNullableDateValue(value.endedAt) &&
    isNullableString(value.manifestChecksum) &&
    isObjectRecord(coverage) &&
    nonnegativeNumber(coverage.completed) &&
    nonnegativeNumber(coverage.limited) &&
    nonnegativeNumber(coverage.notApplicable) &&
    (standards === undefined ||
      (Array.isArray(standards) &&
        standards.every((standard) => {
          if (!isObjectRecord(standard) || !Array.isArray(standard.categories)) return false
          return (
            isString(standard.name) &&
            isString(standard.version) &&
            (standard.badge === undefined || isString(standard.badge)) &&
            nonnegativeNumber(standard.evaluated) &&
            nonnegativeNumber(standard.requiresAttestation) &&
            nonnegativeNumber(standard.notEvaluated) &&
            nonnegativeNumber(standard.violationSignals) &&
            standard.categories.every(
              (category) =>
                isObjectRecord(category) &&
                isString(category.id) &&
                isString(category.title) &&
                ["evaluated", "requires-attestation", "not-evaluated"].includes(
                  String(category.state)
                ) &&
                typeof category.limited === "boolean" &&
                nonnegativeNumber(category.violationSignals) &&
                typeof category.attestable === "boolean"
            )
          )
        }))) &&
    (urlExecution === undefined ||
      (isObjectRecord(urlExecution) &&
        isString(urlExecution.profile) &&
        isStringArray(urlExecution.methods) &&
        [
          urlExecution.subjectCount,
          urlExecution.documentCount,
          urlExecution.assetCount,
          urlExecution.operationCount,
          urlExecution.methodProbeCount,
          urlExecution.originProbeCount,
          urlExecution.totalBytes,
        ].every(nonnegativeNumber) &&
        typeof urlExecution.truncated === "boolean" &&
        isStringArray(urlExecution.issueCodes)))
  )
}

function isReportAssurance(value: unknown): boolean {
  if (!isObjectRecord(value)) return false
  const scores = value.scoreTrend
  const actions = value.priorityActions
  return (
    ["NOT_EVALUATED", "GO", "GO_WITH_CONDITIONS", "NO_GO"].includes(String(value.verdict)) &&
    (value.score === null ||
      (typeof value.score === "number" &&
        Number.isFinite(value.score) &&
        value.score >= 0 &&
        value.score <= 100)) &&
    isNullableString(value.grade) &&
    isString(value.narrative) &&
    Array.isArray(scores) &&
    scores.every(
      (item) =>
        isObjectRecord(item) &&
        typeof item.score === "number" &&
        Number.isFinite(item.score) &&
        isString(item.grade) &&
        isDateValue(item.computedAt)
    ) &&
    isCountRecord(value.ageBuckets) &&
    Array.isArray(actions) &&
    actions.every(
      (action) =>
        isObjectRecord(action) &&
        isString(action.label) &&
        isString(action.detail) &&
        isString(action.severity)
    ) &&
    isStringArray(value.methodology)
  )
}

function isReportAiAssurance(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.controls) || !Array.isArray(value.evidence)) {
    return false
  }
  return (
    value.version === "ai-assurance/1.0.0" &&
    ["COMPLETE", "INCOMPLETE", "NOT_ASSESSED"].includes(String(value.profileState)) &&
    ["CURRENT", "MISSING", "NOT_ASSESSED"].includes(String(value.threatModelState)) &&
    isString(value.frameworkVersion) &&
    isDateValue(value.generatedAt) &&
    isStringArray(value.methodology) &&
    value.evidence.every(
      (item) =>
        isObjectRecord(item) &&
        isString(item.controlId) &&
        isString(item.state) &&
        (item.evidenceVersionId === null || isString(item.evidenceVersionId)) &&
        isNullableDateValue(item.expiresAt)
    ) &&
    value.controls.every(
      (control) =>
        isObjectRecord(control) &&
        isString(control.controlId) &&
        isString(control.controlTitle) &&
        isString(control.state) &&
        (control.status === null || isString(control.status)) &&
        (control.version === null || nonnegativeNumber(control.version)) &&
        (control.attestation === null || isString(control.attestation)) &&
        isNullableDateValue(control.expiresAt) &&
        (control.reviewedById === null || isString(control.reviewedById)) &&
        isNullableDateValue(control.reviewedAt) &&
        Array.isArray(control.artifacts) &&
        control.artifacts.every(
          (artifact) =>
            isObjectRecord(artifact) &&
            isString(artifact.filename) &&
            isString(artifact.mediaType) &&
            nonnegativeNumber(artifact.byteLength) &&
            isString(artifact.checksum)
        )
    )
  )
}

/** Validate persisted report JSON before passing it to the HTML renderer.
 * Missing version is accepted only for structurally complete legacy snapshots.
 */
export function isReportData(value: unknown): value is ReportData {
  if (
    !isObjectRecord(value) ||
    (value.version !== undefined && value.version !== 2 && value.version !== 3)
  ) {
    return false
  }
  const findings = value.findings
  const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
  const aiAppSecurity = value.aiAppSecurity
  return (
    isString(value.title) &&
    isString(value.type) &&
    isString(value.workspaceName) &&
    (value.audience === undefined ||
      ["developer", "executive", "compliance"].includes(String(value.audience))) &&
    isReportScanInfo(value.scanInfo, value.version === 2) &&
    Array.isArray(findings) &&
    findings.every(isReportFinding) &&
    isCountRecord(value.findingsBySeverity, severities) &&
    (value.findingsByStatus === undefined || isCountRecord(value.findingsByStatus)) &&
    (value.findingsByCategory === undefined || isCountRecord(value.findingsByCategory)) &&
    nonnegativeNumber(value.totalFindings) &&
    nonnegativeNumber(value.verifiedCount) &&
    nonnegativeNumber(value.fixedCount) &&
    isObjectRecord(value.retestSummary) &&
    nonnegativeNumber(value.retestSummary.passed) &&
    nonnegativeNumber(value.retestSummary.failed) &&
    nonnegativeNumber(value.retestSummary.pending) &&
    typeof value.findingsTruncated === "boolean" &&
    isDateValue(value.generatedAt) &&
    (value.assurance === undefined || isReportAssurance(value.assurance)) &&
    (value.aiAssurance === undefined || isReportAiAssurance(value.aiAssurance)) &&
    (aiAppSecurity === undefined ||
      (isObjectRecord(aiAppSecurity) &&
        (aiAppSecurity.score === null ||
          (typeof aiAppSecurity.score === "number" &&
            Number.isFinite(aiAppSecurity.score) &&
            aiAppSecurity.score >= 0 &&
            aiAppSecurity.score <= 100)) &&
        (aiAppSecurity.methodology === null || isString(aiAppSecurity.methodology)) &&
        (aiAppSecurity.assessedCount === null || nonnegativeNumber(aiAppSecurity.assessedCount)) &&
        (aiAppSecurity.totalControls === null || nonnegativeNumber(aiAppSecurity.totalControls)) &&
        (aiAppSecurity.reason === null || isString(aiAppSecurity.reason)) &&
        isDateValue(aiAppSecurity.generatedAt) &&
        isStringArray(aiAppSecurity.methodologyWording))) &&
    (value.webMcpAssurance === undefined || parseWebMcpAssurance(value.webMcpAssurance) !== null)
  )
}

const WEBMCP_SCAN_LIMITS = new Set([
  "max_files",
  "max_file_bytes",
  "max_total_bytes",
  "max_definitions",
  "max_wall_time_ms",
  "max_walk_entries",
  "max_walk_depth",
  "unsupported_language",
])

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function numberRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (
    entries.length !== expectedKeys.length ||
    entries.some(([key, count]) => !expectedKeys.includes(key) || !nonnegativeNumber(count)) ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return null
  }
  return Object.fromEntries(entries) as Record<string, number>
}

const WEBMCP_KIND_KEYS = ["imperative", "declarative"] as const
const WEBMCP_BEHAVIOR_KEYS = ["read", "ui-only", "mutation", "unknown"] as const
const WEBMCP_EXPOSURE_KEYS = [
  "dynamic",
  "wildcard",
  "explicitSelf",
  "explicitTrusted",
  "missingOrUnknown",
] as const
const WEBMCP_CONFIRMATION_KEYS = ["mutationTools", "unconfirmedMutations"] as const
export const WEBMCP_SEVERITY_KEYS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const

/**
 * Parse the per-control finding counts. Legacy receipts were written when fewer
 * controls existed, so a receipt may carry FEWER keys than the current
 * WEBMCP_CONTROL_IDS — missing controls read as 0. Unknown keys (from a newer
 * writer than this reader) are dropped. A present-but-malformed value still
 * fails closed.
 */
function findingsByControlRecord(value: unknown): Record<string, number> | null {
  if (value === undefined) {
    return Object.fromEntries(WEBMCP_CONTROL_IDS.map((controlId) => [controlId, 0]))
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const out: Record<string, number> = Object.fromEntries(
    WEBMCP_CONTROL_IDS.map((controlId) => [controlId, 0])
  )
  for (const [key, count] of Object.entries(value)) {
    if (!nonnegativeNumber(count)) return null
    if (WEBMCP_CONTROL_IDS.includes(key as (typeof WEBMCP_CONTROL_IDS)[number])) {
      out[key] = count
    }
    // Unknown control id (newer writer) — drop, do not fail.
  }
  return out
}

function parseSourceSelection(value: unknown): WebMcpCoverageReceipt["sourceSelection"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const counts = ["eligibleFiles", "selectedFiles", "skippedFiles"] as const
  if (counts.some((key) => !nonnegativeNumber(raw[key]))) return null
  if (raw.scannedBytes !== undefined && !nonnegativeNumber(raw.scannedBytes)) return null
  const skippedByReason = numberRecord(raw.skippedByReason, [
    "fileLimit",
    "totalByteLimit",
    "oversized",
    "unreadable",
  ])
  const limits = numberRecord(raw.limits, [
    "maxFiles",
    "maxFileBytes",
    "maxTotalBytes",
    "maxWalkEntries",
    "maxWalkDepth",
  ])
  const rawLimitsReached = raw.limitsReached
  const limitsReached = Array.isArray(rawLimitsReached)
    ? rawLimitsReached.filter(
        (limit): limit is WebMcpCoverageReceipt["limitsReached"][number] =>
          typeof limit === "string" && WEBMCP_SCAN_LIMITS.has(limit)
      )
    : null
  if (
    !skippedByReason ||
    !limits ||
    !limitsReached ||
    !Array.isArray(rawLimitsReached) ||
    limitsReached.length !== rawLimitsReached.length ||
    limitsReached.length > WEBMCP_SCAN_LIMITS.size ||
    new Set(limitsReached).size !== limitsReached.length
  ) {
    return null
  }
  const eligibleFiles = raw.eligibleFiles as number
  const selectedFiles = raw.selectedFiles as number
  const skippedFiles = raw.skippedFiles as number
  if (selectedFiles > eligibleFiles || skippedFiles !== eligibleFiles - selectedFiles) return null
  if (Object.values(skippedByReason).reduce((sum, count) => sum + count, 0) !== skippedFiles) {
    return null
  }
  return {
    eligibleFiles,
    selectedFiles,
    skippedFiles,
    ...(raw.scannedBytes === undefined ? {} : { scannedBytes: raw.scannedBytes as number }),
    skippedByReason: skippedByReason as NonNullable<
      WebMcpCoverageReceipt["sourceSelection"]
    >["skippedByReason"],
    limits: limits as NonNullable<WebMcpCoverageReceipt["sourceSelection"]>["limits"],
    limitsReached,
  }
}

export function parseWebMcpAssurance(value: unknown): ReportWebMcpAssurance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const numericKeys = [
    "eligibleFiles",
    "scannedFiles",
    "scannedBytes",
    "toolDefinitionsFound",
    "toolDefinitionsAssessed",
    "incompleteDefinitions",
    "imperativeDefinitions",
    "declarativeDefinitions",
  ] as const
  if (numericKeys.some((key) => !nonnegativeNumber(raw[key]))) return null
  if (
    raw.version !== "webmcp-assurance/1" ||
    typeof raw.detectorVersion !== "string" ||
    raw.detectorVersion.length === 0 ||
    raw.detectorVersion.length > 64 ||
    !/^[a-f0-9]{64}$/i.test(String(raw.inventoryChecksum))
  ) {
    return null
  }
  const rawLimitsReached = raw.limitsReached
  if (
    !Array.isArray(rawLimitsReached) ||
    rawLimitsReached.length > WEBMCP_SCAN_LIMITS.size ||
    new Set(rawLimitsReached).size !== rawLimitsReached.length ||
    !rawLimitsReached.every(
      (limit): limit is WebMcpCoverageReceipt["limitsReached"][number] =>
        typeof limit === "string" && WEBMCP_SCAN_LIMITS.has(limit)
    ) ||
    !Array.isArray(raw.methodology) ||
    raw.methodology.length > 10 ||
    raw.methodology.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > 240
    )
  ) {
    return null
  }
  const toolCounts = raw.toolCounts as Record<string, unknown> | undefined
  const byKind = numberRecord(toolCounts?.byKind, WEBMCP_KIND_KEYS)
  const byBehavior = numberRecord(toolCounts?.byBehavior, WEBMCP_BEHAVIOR_KEYS)
  const exposurePosture = numberRecord(raw.exposurePosture, WEBMCP_EXPOSURE_KEYS)
  const confirmationPosture = numberRecord(raw.confirmationPosture, WEBMCP_CONFIRMATION_KEYS)
  if (!byKind || !byBehavior || !exposurePosture || !confirmationPosture) return null
  const findingsByControl = findingsByControlRecord(raw.findingsByControl)
  const findingsBySeverity =
    raw.findingsBySeverity === undefined
      ? Object.fromEntries(WEBMCP_SEVERITY_KEYS.map((severity) => [severity, 0]))
      : numberRecord(raw.findingsBySeverity, WEBMCP_SEVERITY_KEYS)
  const representativeRemediation =
    raw.representativeRemediation === undefined
      ? []
      : parseRepresentativeRemediation(raw.representativeRemediation)
  if (!findingsByControl || !findingsBySeverity || !representativeRemediation) return null
  const sourceSelection =
    raw.sourceSelection === undefined ? undefined : parseSourceSelection(raw.sourceSelection)
  if (raw.sourceSelection !== undefined && !sourceSelection) return null
  if (
    (raw.scannedFiles as number) > (raw.eligibleFiles as number) ||
    (raw.toolDefinitionsAssessed as number) > (raw.toolDefinitionsFound as number) ||
    (sourceSelection &&
      ((raw.eligibleFiles as number) > sourceSelection.selectedFiles ||
        (sourceSelection.scannedBytes !== undefined &&
          (raw.scannedBytes as number) > sourceSelection.scannedBytes)))
  ) {
    return null
  }
  const coverageState =
    raw.coverageState === "COMPLETE" &&
    sourceSelection?.skippedFiles === 0 &&
    sourceSelection.limitsReached.length === 0 &&
    rawLimitsReached.length === 0 &&
    (raw.incompleteDefinitions as number) === 0 &&
    (raw.scannedFiles as number) === (raw.eligibleFiles as number) &&
    (raw.toolDefinitionsAssessed as number) === (raw.toolDefinitionsFound as number)
      ? "COMPLETE"
      : "INCONCLUSIVE"

  return {
    version: raw.version,
    detectorVersion: raw.detectorVersion,
    coverageState,
    eligibleFiles: raw.eligibleFiles as number,
    scannedFiles: raw.scannedFiles as number,
    scannedBytes: raw.scannedBytes as number,
    toolDefinitionsFound: raw.toolDefinitionsFound as number,
    toolDefinitionsAssessed: raw.toolDefinitionsAssessed as number,
    incompleteDefinitions: raw.incompleteDefinitions as number,
    imperativeDefinitions: raw.imperativeDefinitions as number,
    declarativeDefinitions: raw.declarativeDefinitions as number,
    limitsReached: rawLimitsReached,
    inventoryChecksum: String(raw.inventoryChecksum),
    ...(sourceSelection ? { sourceSelection } : {}),
    toolCounts: { byKind, byBehavior },
    exposurePosture: exposurePosture as ReportWebMcpAssurance["exposurePosture"],
    confirmationPosture: confirmationPosture as ReportWebMcpAssurance["confirmationPosture"],
    findingsByControl: findingsByControl as ReportWebMcpAssurance["findingsByControl"],
    findingsBySeverity: findingsBySeverity as ReportWebMcpAssurance["findingsBySeverity"],
    representativeRemediation,
    methodology: raw.methodology as string[],
  }
}

export function webMcpFindingIdentity(finding: {
  title: string
  candidates?: Array<{ payload: unknown }>
}): WebMcpControlId | null {
  const candidates = finding.candidates ?? []
  for (const candidate of candidates) {
    if (
      !candidate.payload ||
      typeof candidate.payload !== "object" ||
      Array.isArray(candidate.payload)
    )
      continue
    const payload = candidate.payload as Record<string, unknown>
    if (
      payload.findingClass === "webmcp_tool_surface" &&
      WEBMCP_CONTROL_IDS.includes(payload.id as WebMcpControlId)
    ) {
      return payload.id as WebMcpControlId
    }
  }
  return candidates.length === 0 ? (WEBMCP_CONTROL_ID_BY_TITLE.get(finding.title) ?? null) : null
}

function parseRepresentativeRemediation(
  value: unknown
): ReportWebMcpAssurance["representativeRemediation"] | null {
  if (!Array.isArray(value) || value.length > 5) return null
  const parsed: ReportWebMcpAssurance["representativeRemediation"] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    const raw = item as Record<string, unknown>
    if (
      Object.keys(raw).some((key) => !["controlId", "severity", "text"].includes(key)) ||
      !WEBMCP_CONTROL_IDS.includes(raw.controlId as WebMcpControlId) ||
      !WEBMCP_SEVERITY_KEYS.includes(raw.severity as WebMcpSeverity) ||
      typeof raw.text !== "string" ||
      raw.text.length === 0 ||
      raw.text.length > 240
    ) {
      return null
    }
    parsed.push({
      controlId: raw.controlId as WebMcpControlId,
      severity: raw.severity as WebMcpSeverity,
      text: raw.text,
    })
  }
  return parsed
}
