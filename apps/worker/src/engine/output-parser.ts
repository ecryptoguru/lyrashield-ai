import { logger } from "@lyrashield/logger"
import type { z } from "zod"
import { checkOutputSafety, computeDedupeKey } from "@lyrashield/security"
import {
  advisoryCvssSchema,
  checkRunRecordSchemaVersion,
  coverageGapSchema,
  engineCoverageDocumentSchema,
  engineRunRecordSchema,
  engineVulnerabilitySchema,
  findingRevisionSchema,
  fixVerificationSchema,
  httpExchangeExportSchema,
  MAX_COVERAGE_GAPS,
  MAX_EVIDENCE_FIELD_CHARS,
  MAX_FINDING_REVISIONS,
  MAX_HTTP_EXCHANGE_IDS,
  MAX_INGESTION_ISSUES,
  MAX_INGESTION_ISSUE_CHARS,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_NESTED_ENTRIES,
  MAX_METADATA_NESTED_VALUE_CHARS,
  MAX_METADATA_VALUE_CHARS,
  MAX_SCOPED_COVERAGE_ENTRIES,
  MAX_THREAT_MODELS,
  scopedCoverageEntrySchema,
  threatModelEntrySchema,
  threatModelsDocumentSchema,
} from "./engine-output-schema"

/**
 * dependency_metadata is a bounded flat provenance record that may also carry
 * structured contextual-CVSS members (advisory score, contextual score,
 * vector, per-metric breakdown, reasoning). Values stay shallow: short
 * strings, finite numbers, booleans, or a one-level string map — deep JSON
 * never survives the worker boundary.
 */
export type EngineMetadataValue = string | number | boolean | Record<string, string>

/**
 * Structured advisory CVSS (upstream `{score, vector, source,
 * metric_reasoning}`). The advisory score is evidence about the dependency,
 * never the finding's normalized CVSS.
 */
export interface AdvisoryCvss {
  score: number
  vector?: string
  source?: string
  metric_reasoning?: string
}

/**
 * fix_verification — an ENGINE ATTESTATION that the filing agent ran a fix
 * check (`kind: "engine_attestation"`). It is evidence, never a verification
 * receipt and never proof that a fix works.
 */
export interface FixVerificationAttestation {
  kind?: string
  statement: string
  method?: string
  evidence_refs?: string[]
}

/** Append-only engine revision attribution for a finding. */
export interface FindingRevision {
  timestamp: string
  fields: string[]
  dropped_fields?: string[]
  reason?: string
  agent_id?: string
  agent_name?: string
  previous_severity?: string
  previous_cvss?: number
  previous_confidence?: string
}

export interface EngineVulnerability {
  id: string
  title: string
  severity: string
  timestamp: string
  target?: string
  endpoint?: string
  method?: string
  cve?: string
  cwe?: string
  cvss?: number
  cvss_breakdown?: Record<string, string>
  description?: string
  impact?: string
  technical_analysis?: string
  evidence?: string
  assumptions?: string
  fix_effort?: "trivial" | "low" | "medium" | "high"
  finding_class?: string
  dependency_metadata?: Record<string, EngineMetadataValue>
  poc_description?: string
  poc_script_code?: string
  remediation_steps?: string
  control_ids?: number[]
  // ── run.json 1.1 evidence fields ──────────────────────────────────────────
  // All of these are engine-asserted evidence. The engine's own `verified`
  // claim is deliberately NOT part of this interface: it is untrusted input
  // and is dropped at the boundary. App verification only ever comes from
  // FindingVerification receipts written by trusted paths.
  counterevidence?: string
  /** Engine-declared confidence (wire field `confidence`); evidence only. */
  engine_confidence?: "high" | "medium" | "low"
  confidence_rationale?: string
  severity_change_conditions?: string
  /** Engine attestation object — never a verification receipt. */
  fix_verification?: FixVerificationAttestation
  contextual_cvss_reasoning?: string
  advisory_cvss?: AdvisoryCvss
  /**
   * Proxy exchange ids the finding cites. Only present when the ids survived
   * both shape validation and (when an exchange export is available) the
   * current-scan exchange index; they are evidence references, never a
   * verification receipt.
   */
  http_exchange_ids?: string[]
  /**
   * True when the engine declared exchange references that were dropped during
   * ingestion (unknown ids, or the exchange export was unavailable). The flag
   * keeps the dropped-evidence warning durable beside the finding.
   */
  http_exchange_refs_dropped?: boolean
  update_history?: FindingRevision[]
  updated_at?: string
  /** Engine-recorded per-finding ingestion warnings. */
  evidence_warnings?: string[]
  /** Upstream evidence-schema stamp ("1.1") — provenance only. */
  evidence_contract_version?: string
  /**
   * The engine's declared verification_state verbatim (wire field
   * `verification_state`). Engine-asserted evidence — it can never become the
   * app's verification status.
   */
  engine_verification_state?: string
  code_locations?: Array<{
    file?: string
    start_line?: number
    end_line?: number
    label?: string
    snippet?: string
    fix_before?: string
    fix_after?: string
  }>
  agent_id?: string
  agent_name?: string
  /** Internal detector provenance, attached by the orchestrator after parsing. */
  scannerSource?:
    | "engine"
    | "sca"
    | "secrets"
    | "url"
    | "agent_config"
    | "ai_app_security"
    | "ml_supply_chain"
    | "sast"
    | "iac"
    | "external_import"
  /** Every detector that independently produced the normalized finding. */
  corroboratingSources?: Array<
    | "engine"
    | "sca"
    | "secrets"
    | "url"
    | "agent_config"
    | "ai_app_security"
    | "ml_supply_chain"
    | "sast"
    | "iac"
    | "external_import"
  >
}

export interface EngineRunRecord {
  schema_version?: string
  run_id: string
  run_name: string | null
  start_time: string
  end_time: string | null
  status: string
  targets_info?: unknown[]
  llm_usage?: Record<string, unknown>
  webSearchCostUsd?: number
  scan_results?: Record<string, unknown>
  engine_version?: string
  prompt_bundle_hash?: string
  model?: string
  reasoning_effort?: string
  delegate_model?: string
  delegate_reasoning_effort?: string
  model_routing_policy?: string
  compaction_trigger_tokens?: number
  compaction_target_tokens?: number
  max_output_tokens?: number
  max_agents?: number
  cleanup?: { sandbox_removed: boolean }
  scan_mode?: string
  terminal_reason?: string
  /** run.json 1.1: monotonic revision of the run's report artifacts. */
  report_artifacts_revision?: number
  /** run.json 1.1: the engine's exchange-export outcome (evidence status). */
  evidence_export?: {
    status?: "exported" | "partial" | "skipped" | "failed"
    reason?: string
    exchanges?: number
    missing_request_ids?: string[]
  }
}

/** Agent-reported coverage outcome from coverage.json (upstream VALID_OUTCOMES). */
export type ScopedCoverageOutcome =
  "reported" | "no_issue_found" | "ruled_out" | "not_applicable" | "needs_follow_up"

/**
 * One model-declared scoped coverage entry. `subject` is the surface the
 * agent says it looked at; `outcome` is its declared close reason; neither is
 * a deterministic control outcome.
 */
export interface ScopedCoverageEntry {
  id: string
  subject: string
  outcome: ScopedCoverageOutcome
  reason?: string
  evidenceRefs?: string[]
  recordedBy?: string
  recordedAt?: string
  updatedAt?: string
  previousOutcomes?: string[]
}

/** A coverage gap the engine's runtime or agents declared unexamined. */
export interface EngineCoverageGap {
  kind: string
  subject?: string
  detail: string
}

export interface ParsedEngineCoverage {
  schemaVersion?: string
  entries: ScopedCoverageEntry[]
  gaps: EngineCoverageGap[]
  completeness?: { complete: boolean; caveats: string[] }
}

export interface ParsedThreatModelEntry {
  target: string
  writtenAt?: string
  writtenBy?: string
  content: string
  amendments?: Array<{ at?: string; by?: string; content: string }>
}

export interface ParsedThreatModels {
  schemaVersion?: string
  models: ParsedThreatModelEntry[]
  /** Canonical bounded JSON persisted to encrypted artifact storage. */
  document: string
}

export interface ParsedHttpExchangeExport {
  schemaVersion?: string
  exchangeCount: number
  /** The exchange ids the scan's proxy export attests for this run. */
  knownIds: Set<string>
  /** Canonical bounded JSON persisted to encrypted artifact storage. */
  document: string
}

/**
 * Optional run.json 1.1 sibling artifacts, read bounded by the runner.
 * `undefined` means the artifact is absent; `null` means it existed but
 * failed the bounded read (oversized or unreadable) — an explicit ingestion
 * issue rather than a silently missing artifact.
 */
export interface EngineArtifactInput {
  coverageRaw?: string | null
  threatModelsRaw?: string | null
  httpExchangesRaw?: string | null
}

export interface ParsedScanOutput {
  vulnerabilities: EngineVulnerability[]
  runRecord: EngineRunRecord | null
  summary: string
  findingCount: number
  /** False when the engine did not provide a valid findings artifact. */
  findingsComplete: boolean
  /**
   * Explicit evidence-ingestion issues — malformed or unverifiable evidence
   * that was dropped rather than silently trusted. Bounded.
   */
  ingestionIssues: string[]
  /** Model-declared scoped coverage (coverage.json), never control outcomes. */
  scopedCoverage: ParsedEngineCoverage | null
  /** Versioned scan-bound threat model document (threat_model.json). */
  threatModels: ParsedThreatModels | null
  /** The scan's bounded proxy-exchange export (http_exchanges.json). */
  httpExchangeExport: ParsedHttpExchangeExport | null
}

const VALID_SEVERITIES = new Set([
  "critical",
  "high",
  "medium",
  "moderate",
  "low",
  "info",
  "informational",
])
const MAX_ENGINE_FINDINGS = 1_000
const MAX_TEXT_FIELD_LENGTH = 64 * 1024
const MAX_CODE_LOCATIONS = 100
const MAX_RUN_TARGETS = 100
const MAX_CONTROL_IDS = 10
const MAX_LLM_USAGE_NODES = 500
const MAX_DB_INTEGER = 2_147_483_647
const MAX_DB_DECIMAL_12_6 = 1_000_000
const MAX_LLM_USAGE_REQUESTS = 10_000
const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const CONTROL_ID_TOKEN_PATTERN = /^-?\d+$/
const HTTP_EXCHANGE_ID_PATTERN = /^[0-9]{1,128}$/

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT_FIELD_LENGTH ? value : undefined
}

/**
 * Bounded sink for explicit evidence-ingestion issues. Issues are capped so a
 * hostile artifact cannot flood scan storage; once full, only a truncation
 * marker is appended.
 */
function recordIngestionIssue(issues: string[] | undefined, message: string): void {
  if (!issues) return
  if (issues.length >= MAX_INGESTION_ISSUES) {
    if (issues.length === MAX_INGESTION_ISSUES) {
      issues.push(`further ingestion issues truncated after ${MAX_INGESTION_ISSUES} entries`)
    }
    return
  }
  issues.push(
    message.length > MAX_INGESTION_ISSUE_CHARS
      ? `${message.slice(0, MAX_INGESTION_ISSUE_CHARS)}…`
      : message
  )
}

function boundedStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_METADATA_ENTRIES) return undefined
  const normalized: Record<string, string> = {}
  for (const [key, candidate] of entries) {
    if (key.length > 128 || typeof candidate !== "string" || candidate.length > 4_096) {
      return undefined
    }
    normalized[key] = candidate
  }
  return normalized
}

/** One bounded metadata value: short string, finite number, boolean, or flat string map. */
function boundedMetadataValue(candidate: unknown): EngineMetadataValue | undefined {
  if (typeof candidate === "string") {
    return candidate.length <= MAX_METADATA_VALUE_CHARS ? candidate : undefined
  }
  if (typeof candidate === "number") {
    return Number.isFinite(candidate) && Math.abs(candidate) <= MAX_DB_INTEGER
      ? candidate
      : undefined
  }
  if (typeof candidate === "boolean") return candidate
  if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
    const nested = Object.entries(candidate)
    if (nested.length === 0 || nested.length > MAX_METADATA_NESTED_ENTRIES) return undefined
    const flat: Record<string, string> = {}
    for (const [nestedKey, nestedValue] of nested) {
      if (
        nestedKey.length > 64 ||
        typeof nestedValue !== "string" ||
        nestedValue.length > MAX_METADATA_NESTED_VALUE_CHARS
      ) {
        return undefined
      }
      flat[nestedKey] = nestedValue
    }
    return flat
  }
  return undefined
}

function boundedMetadataRecord(
  value: unknown,
  findingId: string,
  issues?: string[]
): Record<string, EngineMetadataValue> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: dependency_metadata is not an object — field dropped`
    )
    return undefined
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return undefined
  if (entries.length > MAX_METADATA_ENTRIES) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: dependency_metadata exceeds ${MAX_METADATA_ENTRIES} entries — field dropped`
    )
    return undefined
  }
  const normalized: Record<string, EngineMetadataValue> = {}
  for (const [key, candidate] of entries) {
    const normalizedValue = key.length <= 128 ? boundedMetadataValue(candidate) : undefined
    if (normalizedValue === undefined) {
      recordIngestionIssue(
        issues,
        `finding ${findingId}: dependency_metadata.${key.slice(0, 64)} is not a bounded metadata value — field dropped`
      )
      return undefined
    }
    normalized[key] = normalizedValue
  }
  return normalized
}

function validateCodeLocations(value: unknown): EngineVulnerability["code_locations"] {
  if (!Array.isArray(value) || value.length > MAX_CODE_LOCATIONS) return undefined
  const locations: NonNullable<EngineVulnerability["code_locations"]> = []
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const startLine = candidate.start_line
    const endLine = candidate.end_line
    if (
      (startLine !== undefined &&
        (typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1)) ||
      (endLine !== undefined &&
        (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < 1))
    ) {
      continue
    }
    locations.push({
      ...(boundedString(candidate.file) ? { file: boundedString(candidate.file) } : {}),
      ...(typeof startLine === "number" ? { start_line: startLine } : {}),
      ...(typeof endLine === "number" ? { end_line: endLine } : {}),
      ...(boundedString(candidate.label) ? { label: boundedString(candidate.label) } : {}),
      ...(boundedString(candidate.snippet) ? { snippet: boundedString(candidate.snippet) } : {}),
      ...(boundedString(candidate.fix_before)
        ? { fix_before: boundedString(candidate.fix_before) }
        : {}),
      ...(boundedString(candidate.fix_after)
        ? { fix_after: boundedString(candidate.fix_after) }
        : {}),
    })
  }
  return locations
}

function parseControlIdTokens(value: string): number[] {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed)
      return parseControlIds(parsed)
    } catch (err) {
      logger.warn("Engine output: invalid control_id JSON string", {
        value: trimmed.slice(0, 80),
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  if (!CONTROL_ID_TOKEN_PATTERN.test(trimmed)) return []
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) ? [parsed] : []
}

function parseControlIds(value: unknown, depth = 0): number[] {
  if (depth > 1) return []
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        return parseControlIds(JSON.parse(trimmed), depth)
      } catch {
        return []
      }
    }
    if (trimmed.includes(",") || trimmed.includes(";")) {
      return value.split(/[,;]/).flatMap((token) => parseControlIds(token, depth + 1))
    }
    return parseControlIdTokens(value)
  }
  if (!Array.isArray(value)) return []
  if (value.length > MAX_CONTROL_IDS) return []

  return value.flatMap((candidate) => {
    if (typeof candidate === "string") {
      const tokenized = parseControlIds(candidate, depth + 1)
      if (tokenized.length > 0) {
        return tokenized
      }
      return []
    }
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return [candidate]
    }
    return parseControlIds(candidate, depth + 1)
  })
}

function validateControlIds(value: unknown): number[] | undefined {
  const normalizedIds = parseControlIds(value)
  const controlIds = [
    ...new Set(normalizedIds.filter((candidate) => candidate >= 1 && candidate <= 50)),
  ]
  return controlIds.length > 0 ? controlIds : undefined
}

/**
 * Per-artifact evidence context for the ingestion path.
 *
 * `httpExchangeIds` carries the run's exported exchange-id index:
 * - `undefined` — the caller supplies no export context (standalone parsing);
 *   declared refs are carried as engine-asserted evidence, never trusted.
 * - `null` — an ingestion context exists but the export is absent or
 *   unreadable; declared refs are omitted and a warning is recorded.
 * - `Set<string>` — the current scan's exchange ids; refs not in the set are
 *   unknown and fail validation.
 */
interface EvidenceIngestionContext {
  issues?: string[]
  httpExchangeIds?: Set<string> | null
}

function evidenceString(
  value: unknown,
  field: string,
  findingId: string,
  issues?: string[]
): string | undefined {
  if (value === undefined) return undefined
  // The 1.1 evidence fields carry the writer's own 10K bound, not the looser
  // legacy 64K text bound.
  const result =
    typeof value === "string" && value.length <= MAX_EVIDENCE_FIELD_CHARS ? value : undefined
  if (result === undefined) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${field} is malformed or oversized — field dropped`
    )
  }
  return result
}

function parseEngineConfidence(
  value: unknown,
  findingId: string,
  issues?: string[]
): EngineVulnerability["engine_confidence"] {
  if (value === undefined) return undefined
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : undefined
  if (candidate === "high" || candidate === "medium" || candidate === "low") {
    return candidate
  }
  recordIngestionIssue(
    issues,
    `finding ${findingId}: confidence claim is not a recognized level — field dropped`
  )
  return undefined
}

function parseAdvisoryCvss(
  value: unknown,
  findingId: string,
  issues?: string[]
): AdvisoryCvss | undefined {
  if (value === undefined) return undefined
  // A bare advisory number normalizes to the structured form so nothing
  // downstream sees an unlabelled number; every other non-object shape drops.
  let candidate: unknown = value
  if (typeof value === "number") {
    candidate = value >= 0 && value <= 10 ? { score: value } : undefined
  } else if (typeof value !== "object" || value === null || Array.isArray(value)) {
    candidate = undefined
  }
  if (candidate === undefined) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: advisory_cvss is not a bounded score or structured object — field dropped`
    )
    return undefined
  }
  const parsed = advisoryCvssSchema.safeParse(candidate)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: advisory_cvss failed validation — field dropped`
    )
    return undefined
  }
  return parsed.data
}

/**
 * fix_verification accepts a bare statement string or the attestation object
 * and always normalizes to `{kind: "engine_attestation", ...}` — matching the
 * upstream writer so the marker survives the worker boundary intact.
 */
function parseFixVerification(
  value: unknown,
  findingId: string,
  issues?: string[]
): FixVerificationAttestation | undefined {
  if (value === undefined) return undefined
  const candidate = typeof value === "string" ? { statement: value } : value
  const parsed = fixVerificationSchema.safeParse(candidate)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: fix_verification is malformed — field dropped`
    )
    return undefined
  }
  return { ...parsed.data, kind: parsed.data.kind ?? "engine_attestation" }
}

function parseHttpExchangeIds(
  value: unknown,
  findingId: string,
  ctx?: EvidenceIngestionContext
): { ids?: string[]; refsDropped?: boolean } {
  if (value === undefined) return {}
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids is not a list — field dropped`
    )
    return { refsDropped: true }
  }
  const distinct: string[] = []
  let malformed = false
  for (const item of value) {
    if (typeof item !== "string" || !HTTP_EXCHANGE_ID_PATTERN.test(item)) {
      malformed = true
      continue
    }
    if (!distinct.includes(item)) distinct.push(item)
  }
  if (malformed) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids contained non-numeric or oversized ids — entries dropped`
    )
  }
  if (distinct.length === 0) return { refsDropped: value.length > 0 }
  if (distinct.length > MAX_HTTP_EXCHANGE_IDS) {
    recordIngestionIssue(
      ctx?.issues,
      `finding ${findingId}: http_exchange_ids exceeds ${MAX_HTTP_EXCHANGE_IDS} distinct ids — field dropped`
    )
    return { refsDropped: true }
  }
  // No exchange-export context: carry the refs as engine-asserted evidence.
  // They are claims, not verification receipts.
  if (ctx?.httpExchangeIds === undefined) return { ids: distinct }
  if (ctx.httpExchangeIds === null) {
    recordIngestionIssue(
      ctx.issues,
      `finding ${findingId}: proxy exchange export unavailable — http_exchange_ids omitted (unverifiable)`
    )
    return { refsDropped: true }
  }
  const knownIds: Set<string> = ctx.httpExchangeIds
  const unknown = distinct.filter((id) => !knownIds.has(id))
  if (unknown.length > 0) {
    recordIngestionIssue(
      ctx.issues,
      `finding ${findingId}: http_exchange_ids reference unknown exchange id(s) ${unknown
        .map((id) => id.slice(0, 32))
        .join(", ")} — field dropped`
    )
    return { refsDropped: true }
  }
  return { ids: distinct }
}

function parseEvidenceWarnings(
  value: unknown,
  findingId: string,
  issues?: string[]
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: evidence_warnings is not a list — field dropped`
    )
    return undefined
  }
  const warnings: string[] = []
  let dropped = 0
  for (const item of value.slice(0, 10)) {
    if (typeof item === "string" && item.length <= MAX_EVIDENCE_FIELD_CHARS) {
      warnings.push(item)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${dropped} malformed evidence_warnings entr${dropped === 1 ? "y" : "ies"} dropped`
    )
  }
  if (value.length > 10) {
    recordIngestionIssue(issues, `finding ${findingId}: evidence_warnings truncated at 10 entries`)
  }
  return warnings.length > 0 ? warnings : undefined
}

function parseUpdateHistory(
  value: unknown,
  findingId: string,
  issues?: string[]
): FindingRevision[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: update_history is not a list — field dropped`
    )
    return undefined
  }
  const entries: FindingRevision[] = []
  let dropped = 0
  for (const item of value.slice(0, MAX_FINDING_REVISIONS)) {
    const parsed = findingRevisionSchema.safeParse(item)
    if (parsed.success) {
      entries.push(parsed.data)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: ${dropped} malformed update_history entr${dropped === 1 ? "y" : "ies"} dropped`
    )
  }
  if (value.length > MAX_FINDING_REVISIONS) {
    recordIngestionIssue(
      issues,
      `finding ${findingId}: update_history truncated at ${MAX_FINDING_REVISIONS} revisions`
    )
  }
  return entries.length > 0 ? entries : undefined
}

function usageInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DB_INTEGER
    ? value
    : undefined
}

function usageCost(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < MAX_DB_DECIMAL_12_6
    ? value
    : undefined
}

function webSearchCostUsd(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined
  let total = 0
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
    const cost = usageCost((entry as Record<string, unknown>).cost)
    if (cost === undefined) return undefined
    total += cost
  }
  return value.length > 0 ? Math.round(total * 1_000_000) / 1_000_000 : undefined
}

function findUsageMetric(
  value: unknown,
  keys: ReadonlySet<string>,
  validate: (candidate: unknown) => number | undefined,
  visited = { count: 0, truncated: false },
  depth = 0
): number | undefined {
  if (value === null) return undefined
  if (depth > 4 || visited.count >= MAX_LLM_USAGE_NODES) {
    if (typeof value === "object") visited.truncated = true
    return undefined
  }
  visited.count += 1
  if (Array.isArray(value)) {
    let total: number | undefined
    for (const item of value) {
      if (visited.count >= MAX_LLM_USAGE_NODES) {
        visited.truncated = true
        break
      }
      const candidate = findUsageMetric(item, keys, validate, visited, depth + 1)
      if (candidate !== undefined) {
        total = validate((total ?? 0) + candidate)
        if (total === undefined) return undefined
      }
    }
    return visited.truncated ? undefined : total
  }
  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const direct = validate(record[key])
    if (direct !== undefined) return direct
  }
  let total: number | undefined
  for (const property in record) {
    if (!Object.prototype.hasOwnProperty.call(record, property)) continue
    if (visited.count >= MAX_LLM_USAGE_NODES) {
      visited.truncated = true
      break
    }
    const candidate = findUsageMetric(record[property], keys, validate, visited, depth + 1)
    if (candidate !== undefined) {
      total = validate((total ?? 0) + candidate)
      if (total === undefined) return undefined
    }
  }
  return visited.truncated ? undefined : total
}

function normalizeLlmUsage(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const inputTokenDetails =
    typeof record.input_tokens_details === "object" &&
    record.input_tokens_details !== null &&
    !Array.isArray(record.input_tokens_details)
      ? (record.input_tokens_details as Record<string, unknown>)
      : undefined
  // Prefer the aggregate root counters. A wide per-request usage payload may
  // exceed the bounded recursive traversal, which previously dropped cached
  // input tokens and made the stored cost impossible to reconcile.
  const directInteger = (key: string) => usageInteger(record[key])
  const requests = findUsageMetric(
    record,
    new Set(["request_count", "requests_count", "requests"]),
    usageInteger
  )
  const requestCount =
    requests ?? (Array.isArray(record.requests) ? usageInteger(record.requests.length) : undefined)
  const inputTokens =
    directInteger("input_tokens") ??
    findUsageMetric(
      record,
      new Set(["input_tokens", "prompt_tokens", "input_token_count"]),
      usageInteger
    )
  const cachedInputTokens =
    usageInteger(inputTokenDetails?.cached_tokens) ??
    directInteger("cached_input_tokens") ??
    sumRequestUsageDetail(record.request_usage_entries, "cached_tokens") ??
    findUsageMetric(record, new Set(["cached_input_tokens", "cached_tokens"]), usageInteger)
  const cacheWriteInputTokens =
    usageInteger(inputTokenDetails?.cache_write_tokens) ??
    directInteger("cache_write_input_tokens") ??
    findUsageMetric(
      record,
      new Set(["cache_write_input_tokens", "cache_write_tokens"]),
      usageInteger
    )
  const outputTokens =
    directInteger("output_tokens") ??
    findUsageMetric(
      record,
      new Set(["output_tokens", "completion_tokens", "output_token_count"]),
      usageInteger
    )
  const reportedTotalTokens = findUsageMetric(
    record,
    new Set(["total_tokens", "token_count"]),
    usageInteger
  )
  const totalTokens =
    reportedTotalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? usageInteger((inputTokens ?? 0) + (outputTokens ?? 0))
      : undefined)
  const totalCostUsd = ["total_cost_usd", "cost_usd", "total_cost", "cost"]
    .map((key) => usageCost(record[key]))
    .find((candidate) => candidate !== undefined)
  const requestUsageBuckets = normalizeRequestUsageBuckets(record.request_usage_entries)
  const reportedModelUsageBuckets = normalizeModelUsageBuckets(record.model_usage_buckets)
  const normalized = {
    ...(requestCount !== undefined ? { request_count: requestCount } : {}),
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined
      ? { cache_write_input_tokens: cacheWriteInputTokens }
      : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
    ...requestUsageBuckets,
    ...(requestUsageBuckets.model_usage_buckets
      ? {}
      : reportedModelUsageBuckets
        ? { model_usage_buckets: reportedModelUsageBuckets }
        : {}),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

const USAGE_COUNTER_KEYS = [
  "request_count",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "total_tokens",
] as const
const USAGE_BUCKET_KEYS = [
  "standard_input_tokens",
  "standard_cached_input_tokens",
  "standard_cache_write_input_tokens",
  "standard_output_tokens",
  "long_input_tokens",
  "long_cached_input_tokens",
  "long_cache_write_input_tokens",
  "long_output_tokens",
] as const

/**
 * Combines independently metered engine phases only when both receipts expose
 * exact per-request GPT-5.6 buckets. An incomplete receipt stays unpriceable.
 */
export function mergeLlmUsage(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const normalizedBase = normalizeLlmUsage(base)
  const normalizedOverlay = normalizeLlmUsage(overlay)
  if (!normalizedBase || !normalizedOverlay) return undefined

  const merged: Record<string, unknown> = {}
  for (const key of USAGE_COUNTER_KEYS) {
    const baseValue = usageInteger(normalizedBase[key])
    const overlayValue = usageInteger(normalizedOverlay[key])
    if (baseValue === undefined || overlayValue === undefined) return undefined
    const total = usageInteger(baseValue + overlayValue)
    if (total === undefined) return undefined
    merged[key] = total
  }

  const baseBuckets = normalizedBase.model_usage_buckets
  const overlayBuckets = normalizedOverlay.model_usage_buckets
  if (!Array.isArray(baseBuckets) || !Array.isArray(overlayBuckets)) return undefined
  const byModel = new Map<string, Record<(typeof USAGE_BUCKET_KEYS)[number], number>>()
  for (const bucket of [...baseBuckets, ...overlayBuckets]) {
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return undefined
    const record = bucket as Record<string, unknown>
    const model = boundedGpt56Model(record.model)?.trim()
    if (!model) return undefined
    const current = byModel.get(model) ?? ({} as Record<(typeof USAGE_BUCKET_KEYS)[number], number>)
    for (const key of USAGE_BUCKET_KEYS) {
      const value = usageInteger(record[key])
      if (value === undefined) return undefined
      const total = usageInteger((current[key] ?? 0) + value)
      if (total === undefined) return undefined
      current[key] = total
    }
    byModel.set(model, current)
  }
  if (byModel.size === 0 || byModel.size > 3) return undefined
  merged.model_usage_buckets = [...byModel].map(([model, buckets]) => ({ model, ...buckets }))

  const baseCost = usageCost(normalizedBase.total_cost_usd)
  const overlayCost = usageCost(normalizedOverlay.total_cost_usd)
  if (baseCost !== undefined && overlayCost !== undefined) {
    const cost = usageCost(baseCost + overlayCost)
    if (cost === undefined) return undefined
    merged.total_cost_usd = cost
  }
  return merged
}

function detailInteger(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) return detailInteger(value[0], key)
  if (typeof value !== "object" || value === null) return undefined
  return usageInteger((value as Record<string, unknown>)[key])
}

function sumRequestUsageDetail(value: unknown, key: string): number | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_USAGE_REQUESTS) {
    return undefined
  }
  let total = 0
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
    const details = (entry as Record<string, unknown>).input_tokens_details
    const amount = detailInteger(details, key)
    if (amount === undefined) return undefined
    const nextTotal = usageInteger(total + amount)
    if (nextTotal === undefined) return undefined
    total = nextTotal
  }
  return total
}

function boundedGpt56Model(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined
  const normalized = value.toLowerCase().replaceAll("_", "-")
  return /(?:^|[/.-])gpt-5\.6-(?:terra|luna)(?:$|[/.-])/.test(normalized) ? value : undefined
}

function normalizeRequestUsageBuckets(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_USAGE_REQUESTS) {
    return {}
  }
  const buckets = {
    standard_input_tokens: 0,
    standard_cached_input_tokens: 0,
    standard_cache_write_input_tokens: 0,
    standard_output_tokens: 0,
    long_input_tokens: 0,
    long_cached_input_tokens: 0,
    long_cache_write_input_tokens: 0,
    long_output_tokens: 0,
  }
  const modelBuckets = new Map<string, typeof buckets>()
  let everyEntryHasModel = true
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return {}
    const record = entry as Record<string, unknown>
    const inputTokens = usageInteger(record.input_tokens)
    const outputTokens = usageInteger(record.output_tokens)
    const cachedInputTokens = detailInteger(record.input_tokens_details, "cached_tokens") ?? 0
    const cacheWriteInputTokens =
      detailInteger(record.input_tokens_details, "cache_write_tokens") ?? 0
    const model = boundedGpt56Model(record.model)?.trim()
    if (!model) everyEntryHasModel = false
    if (
      inputTokens === undefined ||
      outputTokens === undefined ||
      cachedInputTokens === undefined ||
      cacheWriteInputTokens === undefined ||
      cachedInputTokens > inputTokens ||
      cacheWriteInputTokens > inputTokens - cachedInputTokens
    ) {
      return {}
    }
    const prefix = inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS ? "long" : "standard"
    buckets[`${prefix}_input_tokens` as keyof typeof buckets] += inputTokens
    buckets[`${prefix}_cached_input_tokens` as keyof typeof buckets] += cachedInputTokens
    buckets[`${prefix}_cache_write_input_tokens` as keyof typeof buckets] += cacheWriteInputTokens
    buckets[`${prefix}_output_tokens` as keyof typeof buckets] += outputTokens
    if (model && everyEntryHasModel) {
      const perModel = modelBuckets.get(model) ?? {
        standard_input_tokens: 0,
        standard_cached_input_tokens: 0,
        standard_cache_write_input_tokens: 0,
        standard_output_tokens: 0,
        long_input_tokens: 0,
        long_cached_input_tokens: 0,
        long_cache_write_input_tokens: 0,
        long_output_tokens: 0,
      }
      perModel[`${prefix}_input_tokens` as keyof typeof perModel] += inputTokens
      perModel[`${prefix}_cached_input_tokens` as keyof typeof perModel] += cachedInputTokens
      perModel[`${prefix}_cache_write_input_tokens` as keyof typeof perModel] +=
        cacheWriteInputTokens
      perModel[`${prefix}_output_tokens` as keyof typeof perModel] += outputTokens
      modelBuckets.set(model, perModel)
      if (modelBuckets.size > 3) everyEntryHasModel = false
    }
  }
  return {
    ...buckets,
    ...(everyEntryHasModel && modelBuckets.size > 0
      ? {
          model_usage_buckets: [...modelBuckets].map(([model, usage]) => ({ model, ...usage })),
        }
      : {}),
  }
}

/** Validates the already-normalized buckets persisted in a prior engine receipt. */
function normalizeModelUsageBuckets(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return undefined
  const normalized: Array<Record<string, unknown>> = []
  for (const bucket of value) {
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return undefined
    const record = bucket as Record<string, unknown>
    const model = boundedGpt56Model(record.model)?.trim()
    if (!model) return undefined
    const entry: Record<string, unknown> = { model }
    for (const key of USAGE_BUCKET_KEYS) {
      const amount = usageInteger(record[key])
      if (amount === undefined) return undefined
      entry[key] = amount
    }
    normalized.push(entry)
  }
  return normalized
}

function validateVulnerability(
  v: Record<string, unknown>,
  ctx?: EvidenceIngestionContext
): EngineVulnerability | null {
  const id = boundedString(v.id)
  if (!id?.trim()) return null
  const title = boundedString(v.title)
  if (!title?.trim()) {
    logger.warn("Engine output: missing title, skipping", { id: v.id })
    return null
  }
  const severity = boundedString(v.severity)
  const validSeverity = severity && VALID_SEVERITIES.has(severity.toLowerCase())
  if (!validSeverity) {
    logger.warn("Engine output: invalid severity, defaulting to info", {
      id: v.id,
      severity: v.severity,
    })
  }
  const cvss = typeof v.cvss === "number" && v.cvss >= 0 && v.cvss <= 10 ? v.cvss : undefined
  if (v.cvss !== undefined && cvss === undefined) {
    logger.warn("Engine output: invalid CVSS score, removing", { id: v.id, cvss: v.cvss })
  }
  const rawCwe = boundedString(v.cwe)
  const cweMatch = rawCwe?.match(/^(?:CWE-)?(\d+)$/i)
  if (rawCwe && !cweMatch) {
    logger.warn("Engine output: invalid CWE format, removing", { id: v.id, cwe: v.cwe })
  }
  const timestamp = boundedString(v.timestamp)
  if (!timestamp) return null
  const fixEffort = boundedString(v.fix_effort)?.toLowerCase()
  const validFixEffort =
    fixEffort === "trivial" || fixEffort === "low" || fixEffort === "medium" || fixEffort === "high"
      ? fixEffort
      : undefined
  const cvssBreakdown = boundedStringRecord(v.cvss_breakdown)
  const dependencyMetadata = boundedMetadataRecord(v.dependency_metadata, id, ctx?.issues)
  const controlIds = validateControlIds(v.control_ids)
  const codeLocations = validateCodeLocations(v.code_locations)

  // ── run.json 1.1 evidence fields ──────────────────────────────────────────
  // Additive, bounded, and failure-explicit: malformed values are dropped and
  // recorded as ingestion issues rather than silently trusted. An engine
  // `verified` claim is never read — it is untrusted input that cannot become
  // an app verification receipt.
  const counterevidence = evidenceString(v.counterevidence, "counterevidence", id, ctx?.issues)
  const engineConfidence = parseEngineConfidence(v.confidence, id, ctx?.issues)
  const confidenceRationale = evidenceString(
    v.confidence_rationale,
    "confidence_rationale",
    id,
    ctx?.issues
  )
  const severityChangeConditions = evidenceString(
    v.severity_change_conditions,
    "severity_change_conditions",
    id,
    ctx?.issues
  )
  const fixVerification = parseFixVerification(v.fix_verification, id, ctx?.issues)
  const contextualCvssReasoning = evidenceString(
    v.contextual_cvss_reasoning,
    "contextual_cvss_reasoning",
    id,
    ctx?.issues
  )
  const advisoryCvss = parseAdvisoryCvss(v.advisory_cvss, id, ctx?.issues)
  const httpExchangeRefs = parseHttpExchangeIds(v.http_exchange_ids, id, ctx)
  const updateHistory = parseUpdateHistory(v.update_history, id, ctx?.issues)
  const updatedAt = evidenceString(v.updated_at, "updated_at", id, ctx?.issues)
  const evidenceWarnings = parseEvidenceWarnings(v.evidence_warnings, id, ctx?.issues)
  const evidenceContractVersion =
    typeof v.evidence_contract_version === "string" && v.evidence_contract_version.length <= 64
      ? v.evidence_contract_version
      : undefined
  // The engine's declared verification_state is carried verbatim as
  // engine-asserted evidence. It is NEVER read as a verification receipt.
  const engineVerificationState =
    typeof v.verification_state === "string" && v.verification_state.length <= 64
      ? v.verification_state
      : undefined

  // Detect prompt-injection artifacts that the model may have echoed or acted on.
  const textFields = [
    title,
    boundedString(v.description),
    boundedString(v.impact),
    boundedString(v.technical_analysis),
    boundedString(v.evidence),
    boundedString(v.assumptions),
    boundedString(v.poc_description),
    boundedString(v.poc_script_code),
    boundedString(v.remediation_steps),
    counterevidence,
    confidenceRationale,
    severityChangeConditions,
    fixVerification?.statement,
    fixVerification?.method,
    contextualCvssReasoning,
    advisoryCvss?.metric_reasoning,
    advisoryCvss?.vector,
    advisoryCvss?.source,
    engineVerificationState,
    ...(evidenceWarnings ?? []),
    ...(updateHistory ?? []).flatMap((revision) => [
      revision.reason,
      revision.previous_severity,
      revision.agent_name,
    ]),
  ]
    .filter((field): field is string => typeof field === "string")
    .join("\n")
  const safety = checkOutputSafety(textFields)
  if (!safety.safe) {
    logger.warn("Engine output: filtering finding with prompt-injection artifacts", {
      id,
      detectedPatterns: safety.detectedPatterns,
      reason: safety.reason,
    })
    return null
  }

  return {
    id,
    title,
    severity: validSeverity ? severity : "info",
    timestamp,
    ...(boundedString(v.target) ? { target: boundedString(v.target) } : {}),
    ...(boundedString(v.endpoint) ? { endpoint: boundedString(v.endpoint) } : {}),
    ...(boundedString(v.method) ? { method: boundedString(v.method) } : {}),
    ...(boundedString(v.cve) ? { cve: boundedString(v.cve) } : {}),
    ...(cweMatch ? { cwe: `CWE-${cweMatch[1]}` } : {}),
    ...(cvss !== undefined ? { cvss } : {}),
    ...(boundedString(v.description) ? { description: boundedString(v.description) } : {}),
    ...(boundedString(v.impact) ? { impact: boundedString(v.impact) } : {}),
    ...(boundedString(v.technical_analysis)
      ? { technical_analysis: boundedString(v.technical_analysis) }
      : {}),
    ...(boundedString(v.evidence) ? { evidence: boundedString(v.evidence) } : {}),
    ...(boundedString(v.assumptions) ? { assumptions: boundedString(v.assumptions) } : {}),
    ...(validFixEffort ? { fix_effort: validFixEffort } : {}),
    ...(boundedString(v.finding_class) ? { finding_class: boundedString(v.finding_class) } : {}),
    ...(cvssBreakdown ? { cvss_breakdown: cvssBreakdown } : {}),
    ...(dependencyMetadata ? { dependency_metadata: dependencyMetadata } : {}),
    ...(boundedString(v.poc_description)
      ? { poc_description: boundedString(v.poc_description) }
      : {}),
    ...(boundedString(v.poc_script_code)
      ? { poc_script_code: boundedString(v.poc_script_code) }
      : {}),
    ...(boundedString(v.remediation_steps)
      ? { remediation_steps: boundedString(v.remediation_steps) }
      : {}),
    ...(controlIds ? { control_ids: controlIds } : {}),
    ...(codeLocations ? { code_locations: codeLocations } : {}),
    ...(counterevidence !== undefined ? { counterevidence } : {}),
    ...(engineConfidence !== undefined ? { engine_confidence: engineConfidence } : {}),
    ...(confidenceRationale !== undefined ? { confidence_rationale: confidenceRationale } : {}),
    ...(severityChangeConditions !== undefined
      ? { severity_change_conditions: severityChangeConditions }
      : {}),
    ...(fixVerification !== undefined ? { fix_verification: fixVerification } : {}),
    ...(contextualCvssReasoning !== undefined
      ? { contextual_cvss_reasoning: contextualCvssReasoning }
      : {}),
    ...(advisoryCvss !== undefined ? { advisory_cvss: advisoryCvss } : {}),
    ...(httpExchangeRefs.ids ? { http_exchange_ids: httpExchangeRefs.ids } : {}),
    ...(httpExchangeRefs.refsDropped ? { http_exchange_refs_dropped: true } : {}),
    ...(updateHistory !== undefined ? { update_history: updateHistory } : {}),
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
    ...(evidenceWarnings !== undefined ? { evidence_warnings: evidenceWarnings } : {}),
    ...(evidenceContractVersion !== undefined
      ? { evidence_contract_version: evidenceContractVersion }
      : {}),
    ...(engineVerificationState !== undefined
      ? { engine_verification_state: engineVerificationState }
      : {}),
  }
}

function parseVulnerabilitiesArtifact(
  raw: string,
  ctx?: EvidenceIngestionContext
): {
  vulnerabilities: EngineVulnerability[]
  complete: boolean
} {
  if (!raw.trim()) return { vulnerabilities: [], complete: false }
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) {
      logger.warn("vulnerabilities.json is not an array", { type: typeof data })
      return { vulnerabilities: [], complete: false }
    }
    if (data.length > MAX_ENGINE_FINDINGS) {
      logger.warn("vulnerabilities.json exceeds finding limit", { count: data.length })
      return { vulnerabilities: [], complete: false }
    }
    const validated: EngineVulnerability[] = []
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue
      const vuln = validateVulnerability(item as Record<string, unknown>, ctx)
      if (!vuln) continue
      // Strict schema contract: reject anything that survived coercion but
      // still violates the expected shape or value bounds.
      const parsed = engineVulnerabilitySchema.safeParse(vuln)
      if (!parsed.success) {
        logger.warn("Engine output: vulnerability failed strict schema validation", {
          id: vuln.id,
          errors: parsed.error.issues.map((issue) => issue.message),
        })
        recordIngestionIssue(
          ctx?.issues,
          `finding ${vuln.id.slice(0, 128)}: rejected by strict schema validation`
        )
        continue
      }
      validated.push(vuln)
    }
    return { vulnerabilities: validated, complete: true }
  } catch (err) {
    logger.error("Failed to parse vulnerabilities.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { vulnerabilities: [], complete: false }
  }
}

export function parseVulnerabilitiesJson(raw: string): EngineVulnerability[] {
  return parseVulnerabilitiesArtifact(raw).vulnerabilities
}

export function parseRunJson(raw: string): EngineRunRecord | null {
  if (!raw.trim()) return null
  try {
    const data = JSON.parse(raw)
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null
    const record = data as Record<string, unknown>
    const runId = boundedString(record.run_id)
    const status = boundedString(record.status)
    if (!runId?.trim() || !status?.trim()) {
      logger.warn("run.json is missing required run metadata")
      return null
    }

    const targetsInfo = Array.isArray(record.targets_info)
      ? record.targets_info.slice(0, MAX_RUN_TARGETS).flatMap((target) => {
          if (typeof target !== "object" || target === null || Array.isArray(target)) return []
          const sourcePath = boundedString(
            (target as { details?: { cloned_repo_path?: unknown } }).details?.cloned_repo_path
          )
          return sourcePath ? [{ details: { cloned_repo_path: sourcePath } }] : []
        })
      : undefined
    const llmUsage = normalizeLlmUsage(record.llm_usage)
    const promptBundleHash = boundedString(record.prompt_bundle_hash)
    const delegateModel = boundedString(record.delegate_model)
    const delegateReasoningEffort = boundedString(record.delegate_reasoning_effort)
    const modelRoutingPolicy = boundedString(record.model_routing_policy)
    const compactionTriggerTokens = usageInteger(record.compaction_trigger_tokens)
    const compactionTargetTokens = usageInteger(record.compaction_target_tokens)
    const maxOutputTokens = usageInteger(record.max_output_tokens)
    const maxAgents = usageInteger(record.max_agents)
    const searchCost = webSearchCostUsd(record.web_search_usage)
    const cleanup =
      typeof record.cleanup === "object" &&
      record.cleanup !== null &&
      !Array.isArray(record.cleanup)
        ? (record.cleanup as { sandbox_removed?: unknown })
        : undefined

    const runRecord: EngineRunRecord = {
      ...(boundedString(record.schema_version)
        ? { schema_version: boundedString(record.schema_version) }
        : {}),
      run_id: runId,
      run_name: boundedString(record.run_name) ?? null,
      start_time: boundedString(record.start_time) ?? "",
      end_time: boundedString(record.end_time) ?? null,
      status,
      ...(targetsInfo ? { targets_info: targetsInfo } : {}),
      ...(llmUsage ? { llm_usage: llmUsage } : {}),
      ...(searchCost !== undefined ? { webSearchCostUsd: searchCost } : {}),
      ...(boundedString(record.engine_version)
        ? { engine_version: boundedString(record.engine_version) }
        : {}),
      ...(promptBundleHash && /^[a-f0-9]{64}$/i.test(promptBundleHash)
        ? { prompt_bundle_hash: promptBundleHash.toLowerCase() }
        : {}),
      ...(boundedString(record.model) ? { model: boundedString(record.model) } : {}),
      ...(boundedString(record.reasoning_effort)
        ? { reasoning_effort: boundedString(record.reasoning_effort) }
        : {}),
      ...(delegateModel ? { delegate_model: delegateModel } : {}),
      ...(delegateReasoningEffort ? { delegate_reasoning_effort: delegateReasoningEffort } : {}),
      ...(modelRoutingPolicy ? { model_routing_policy: modelRoutingPolicy } : {}),
      ...(compactionTriggerTokens !== undefined
        ? { compaction_trigger_tokens: compactionTriggerTokens }
        : {}),
      ...(compactionTargetTokens !== undefined
        ? { compaction_target_tokens: compactionTargetTokens }
        : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(maxAgents !== undefined ? { max_agents: maxAgents } : {}),
      ...(typeof cleanup?.sandbox_removed === "boolean"
        ? { cleanup: { sandbox_removed: cleanup.sandbox_removed } }
        : {}),
      ...(boundedString(record.scan_mode) ? { scan_mode: boundedString(record.scan_mode) } : {}),
      ...(boundedString(record.terminal_reason)
        ? { terminal_reason: boundedString(record.terminal_reason) }
        : {}),
      ...(Number.isInteger(record.report_artifacts_revision) &&
      (record.report_artifacts_revision as number) >= 0
        ? { report_artifacts_revision: record.report_artifacts_revision as number }
        : {}),
      ...(parseEvidenceExportOutcome(record.evidence_export)
        ? { evidence_export: parseEvidenceExportOutcome(record.evidence_export) }
        : {}),
    }

    const parsed = engineRunRecordSchema.safeParse(runRecord)
    if (!parsed.success) {
      logger.warn("Engine output: run.json failed strict schema validation", {
        runId,
        errors: parsed.error.issues.map((issue) => issue.message),
      })
      return null
    }

    // Tripwire for cross-repo contract drift. An error-level check means an
    // unsupported MAJOR: the record is rejected rather than ingested under a
    // contract the worker does not understand.
    const versionCheck = checkRunRecordSchemaVersion(parsed.data.schema_version)
    if (versionCheck) {
      logger[versionCheck.level === "error" ? "error" : "warn"](
        "Engine output: run.json schema version check",
        { runId, schemaVersion: parsed.data.schema_version ?? null, ...versionCheck }
      )
      if (versionCheck.level === "error") return null
    }

    return runRecord
  } catch (err) {
    logger.error("Failed to parse run.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Bounded parse of the run-level evidence_export outcome stamp (1.1). */
function parseEvidenceExportOutcome(
  value: unknown
): NonNullable<EngineRunRecord["evidence_export"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as {
    status?: unknown
    reason?: unknown
    exchanges?: unknown
    missing_request_ids?: unknown
  }
  const status = ["exported", "partial", "skipped", "failed"].includes(String(record.status))
    ? (String(record.status) as "exported" | "partial" | "skipped" | "failed")
    : undefined
  const reason = boundedString(record.reason)
  const exchanges =
    Number.isInteger(record.exchanges) && (record.exchanges as number) >= 0
      ? (record.exchanges as number)
      : undefined
  const missing = Array.isArray(record.missing_request_ids)
    ? record.missing_request_ids
        .filter((id): id is string => typeof id === "string" && HTTP_EXCHANGE_ID_PATTERN.test(id))
        .slice(0, 500)
    : undefined
  if (status === undefined && reason === undefined && exchanges === undefined && !missing?.length) {
    return undefined
  }
  return {
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(exchanges !== undefined ? { exchanges } : {}),
    ...(missing?.length ? { missing_request_ids: missing } : {}),
  }
}

function parseJsonArtifact(raw: string, artifact: string, issues?: string[]): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    recordIngestionIssue(issues, `${artifact}: invalid JSON — artifact ignored`)
    return undefined
  }
}

/**
 * coverage.json — the engine's scoped coverage ledger. Entries and gaps are
 * model/runtime declarations; they map into namespaced coverage receipts and
 * never alter deterministic control outcomes.
 */
function parseEngineCoverage(
  raw: string | null | undefined,
  issues?: string[]
): ParsedEngineCoverage | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(issues, "coverage.json unreadable or oversized — artifact ignored")
    return null
  }
  if (!raw.trim()) return null
  const data = parseJsonArtifact(raw, "coverage.json", issues)
  if (data === undefined) return null
  const parsed = engineCoverageDocumentSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(issues, "coverage.json failed schema validation — artifact ignored")
    logger.warn("Engine output: coverage.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  if (doc.truncated?.entries_dropped) {
    recordIngestionIssue(
      issues,
      `coverage.json: engine dropped ${doc.truncated.entries_dropped} entr${doc.truncated.entries_dropped === 1 ? "y" : "ies"} at its ${doc.truncated.entry_limit ?? "declared"} limit`
    )
  }
  const rawEntries = doc.entries ?? []
  if (rawEntries.length > MAX_SCOPED_COVERAGE_ENTRIES) {
    recordIngestionIssue(
      issues,
      `coverage.json: entries truncated at ${MAX_SCOPED_COVERAGE_ENTRIES}`
    )
  }
  const entries: ScopedCoverageEntry[] = []
  const seenIds = new Set<string>()
  let dropped = 0
  for (const [index, rawEntry] of rawEntries.slice(0, MAX_SCOPED_COVERAGE_ENTRIES).entries()) {
    const parsedEntry = scopedCoverageEntrySchema.safeParse(rawEntry)
    if (!parsedEntry.success) {
      dropped += 1
      continue
    }
    const entry = parsedEntry.data
    // The overlay contract uses `id`/`subject`/`investigation_status`/`reason`;
    // the substrate renders `entry_id`/`surface`/`outcome`/`evidence`. Accept
    // either spelling so substrate-only documents still map.
    const declaredId = (entry.id ?? entry.entry_id ?? "").trim()
    const id = declaredId || `entry-${index + 1}`
    if (seenIds.has(id)) {
      recordIngestionIssue(
        issues,
        `coverage.json: duplicate entry id ${id.slice(0, 64)} — entry dropped`
      )
      dropped += 1
      continue
    }
    seenIds.add(id)
    const surface = (entry.subject ?? entry.surface ?? "").trim()
    if (!surface) {
      dropped += 1
      continue
    }
    const outcome = entry.investigation_status ?? entry.outcome
    const reason = (entry.reason ?? entry.evidence ?? "").trim()
    entries.push({
      id,
      subject: entry.risk_area ? `${surface} — ${entry.risk_area}`.slice(0, 4096) : surface,
      outcome,
      ...(reason ? { reason: reason.slice(0, 4096) } : {}),
      ...(entry.evidence_refs?.length ? { evidenceRefs: entry.evidence_refs } : {}),
      ...(entry.recorded_by ? { recordedBy: entry.recorded_by } : {}),
      ...(entry.recorded_at ? { recordedAt: entry.recorded_at } : {}),
      ...(entry.updated_at ? { updatedAt: entry.updated_at } : {}),
      ...(entry.previous_outcomes?.length ? { previousOutcomes: entry.previous_outcomes } : {}),
    })
  }
  if (dropped > 0) {
    recordIngestionIssue(
      issues,
      `coverage.json: ${dropped} entr${dropped === 1 ? "y" : "ies"} dropped — malformed or missing surface`
    )
  }
  const rawGaps = doc.gaps ?? []
  if (rawGaps.length > MAX_COVERAGE_GAPS) {
    recordIngestionIssue(issues, `coverage.json: gaps truncated at ${MAX_COVERAGE_GAPS}`)
  }
  const gaps: EngineCoverageGap[] = []
  let droppedGaps = 0
  for (const rawGap of rawGaps.slice(0, MAX_COVERAGE_GAPS)) {
    const parsedGap = coverageGapSchema.safeParse(rawGap)
    if (!parsedGap.success) {
      droppedGaps += 1
      continue
    }
    const gap = parsedGap.data
    gaps.push({
      kind: gap.kind,
      ...(gap.surface ? { subject: gap.surface.slice(0, 4096) } : {}),
      ...(!gap.surface && gap.risk_area ? { subject: gap.risk_area.slice(0, 256) } : {}),
      ...(!gap.surface && !gap.risk_area && gap.agent_name
        ? { subject: gap.agent_name.slice(0, 256) }
        : {}),
      detail: gap.detail.slice(0, 4096),
    })
  }
  if (droppedGaps > 0) {
    recordIngestionIssue(issues, `coverage.json: ${droppedGaps} malformed gap(s) dropped`)
  }
  return {
    ...(doc.schema_version !== undefined ? { schemaVersion: String(doc.schema_version) } : {}),
    entries,
    gaps,
    ...(doc.completeness
      ? {
          completeness: {
            complete: doc.completeness.complete,
            caveats: doc.completeness.caveats ?? [],
          },
        }
      : {}),
  }
}

function redactThreatModelText(value: string): string {
  return value
    .replace(
      /\b(password|passwd|pwd|api[_-]?key|secret|token|credential|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
}

/**
 * threat_model.json — the owned engine's models array. Older target-keyed
 * documents are adapted by this reader; neither form proves paths were tested.
 */
function parseThreatModels(
  raw: string | null | undefined,
  issues?: string[],
  runId?: string
): ParsedThreatModels | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(issues, "threat_model.json unreadable or oversized — artifact ignored")
    return null
  }
  if (!raw.trim()) return null
  const data = parseJsonArtifact(raw, "threat_model.json", issues)
  if (data === undefined) return null
  const parsed = threatModelsDocumentSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(issues, "threat_model.json failed schema validation — artifact ignored")
    logger.warn("Engine output: threat_model.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  // Canonical owned output is an array. Older upstream documents were bare
  // records or wrapped records; a bare record may contain a key named models.
  type ThreatModelEntry = z.infer<typeof threatModelEntrySchema>
  const maybeModels = (doc as { models?: unknown }).models
  const isCanonical = Array.isArray(maybeModels)
  if (isCanonical && Object.hasOwn(doc, "error")) {
    recordIngestionIssue(issues, "threat_model.json reports a writer error — artifact ignored")
    return null
  }
  if (isCanonical && (!runId || (doc as { run_id?: unknown }).run_id !== runId)) {
    recordIngestionIssue(issues, "threat_model.json run_id mismatch — artifact ignored")
    return null
  }
  const isWrapped =
    typeof maybeModels === "object" &&
    maybeModels !== null &&
    !Array.isArray(maybeModels) &&
    !("content" in maybeModels)
  const schemaVersion =
    (isCanonical || isWrapped) && (doc as { schema_version?: unknown }).schema_version !== undefined
      ? String((doc as { schema_version?: unknown }).schema_version)
      : undefined
  const rawModels = (isCanonical || isWrapped ? maybeModels : doc) as
    ThreatModelEntry[] | Record<string, ThreatModelEntry>
  const models: ParsedThreatModelEntry[] = []
  for (const [key, model] of Object.entries(rawModels)) {
    if (models.length >= MAX_THREAT_MODELS) {
      recordIngestionIssue(issues, `threat_model.json: models truncated at ${MAX_THREAT_MODELS}`)
      break
    }
    if (
      typeof model !== "object" ||
      model === null ||
      Array.isArray(model) ||
      typeof (model as { target?: unknown }).target !== "string" ||
      !model.target.trim() ||
      typeof (model as { content?: unknown }).content !== "string" ||
      !model.content.trim()
    ) {
      recordIngestionIssue(
        issues,
        `threat_model.json: model ${key.slice(0, 64)} malformed — dropped`
      )
      continue
    }
    models.push({
      target: redactThreatModelText(model.target),
      ...(model.written_at ? { writtenAt: redactThreatModelText(model.written_at) } : {}),
      ...(model.written_by ? { writtenBy: redactThreatModelText(model.written_by) } : {}),
      content: redactThreatModelText(model.content),
      ...(model.amendments?.length
        ? {
            amendments: model.amendments.map((amendment) => ({
              ...(amendment.at ? { at: redactThreatModelText(amendment.at) } : {}),
              ...(amendment.by ? { by: redactThreatModelText(amendment.by) } : {}),
              content: redactThreatModelText(amendment.content),
            })),
          }
        : {}),
    })
  }
  if (models.length === 0) {
    recordIngestionIssue(issues, "threat_model.json contains no usable models — artifact ignored")
    return null
  }
  // Persist the validated canonical document — not raw bytes — so nothing
  // outside the declared contract reaches encrypted storage.
  const serializedModels = models.map((model) => ({
    target: model.target,
    ...(model.writtenAt ? { written_at: model.writtenAt } : {}),
    ...(model.writtenBy ? { written_by: model.writtenBy } : {}),
    content: model.content,
    ...(model.amendments?.length
      ? {
          amendments: model.amendments.map((amendment) => ({
            ...(amendment.at ? { at: amendment.at } : {}),
            ...(amendment.by ? { by: amendment.by } : {}),
            content: amendment.content,
          })),
        }
      : {}),
  }))
  const canonical = isCanonical
    ? (doc as {
        generated_at: string
        run_id: string
        run_name?: string
        note?: string
        truncated?: boolean
        error?: string
      })
    : null
  const document = JSON.stringify({
    schema_version: schemaVersion ?? "1.0",
    ...(canonical
      ? {
          generated_at: redactThreatModelText(canonical.generated_at),
          run_id: redactThreatModelText(canonical.run_id),
          ...(canonical.run_name ? { run_name: redactThreatModelText(canonical.run_name) } : {}),
          ...(canonical.note ? { note: redactThreatModelText(canonical.note) } : {}),
          ...(canonical.truncated !== undefined ? { truncated: canonical.truncated } : {}),
          ...(canonical.error ? { error: redactThreatModelText(canonical.error) } : {}),
        }
      : {}),
    models: isCanonical
      ? serializedModels
      : Object.fromEntries(serializedModels.map((model) => [model.target, model])),
  })
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    models,
    document,
  }
}

/**
 * http_exchanges.json — the bounded redacted exchange index exported before
 * sandbox teardown. The id set is the "current proxy project" a finding's
 * http_exchange_ids must validate against; raw exchange bodies never enter
 * this artifact.
 */
function parseHttpExchangeExport(
  raw: string | null | undefined,
  issues?: string[]
): ParsedHttpExchangeExport | null {
  if (raw === undefined) return null
  if (raw === null) {
    recordIngestionIssue(
      issues,
      "http_exchanges.json unreadable or oversized — exchange refs unverifiable"
    )
    return null
  }
  if (!raw.trim()) {
    recordIngestionIssue(issues, "http_exchanges.json is empty — exchange refs unverifiable")
    return null
  }
  const data = parseJsonArtifact(raw, "http_exchanges.json", issues)
  if (data === undefined) return null
  const parsed = httpExchangeExportSchema.safeParse(data)
  if (!parsed.success) {
    recordIngestionIssue(
      issues,
      "http_exchanges.json failed schema validation — exchange refs unverifiable"
    )
    logger.warn("Engine output: http_exchanges.json failed schema validation", {
      errors: parsed.error.issues.map((issue) => issue.message).slice(0, 20),
    })
    return null
  }
  const doc = parsed.data
  const knownIds = new Set(doc.exchanges.map((exchange) => exchange.proxy_request_id))
  // Persist the validated canonical document — not raw bytes — so nothing
  // outside the declared contract reaches encrypted storage.
  const document = JSON.stringify({
    ...(doc.schema_version !== undefined ? { schema_version: doc.schema_version } : {}),
    ...(doc.generated_at ? { generated_at: doc.generated_at } : {}),
    ...(doc.binding ? { binding: doc.binding } : {}),
    exchanges: doc.exchanges,
    ...(doc.missing_request_ids?.length ? { missing_request_ids: doc.missing_request_ids } : {}),
    ...(doc.truncated ? { truncated: doc.truncated } : {}),
  })
  return {
    ...(doc.schema_version !== undefined ? { schemaVersion: String(doc.schema_version) } : {}),
    exchangeCount: doc.exchanges.length,
    knownIds,
    document,
  }
}

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

const SEVERITY_MAP: Record<string, "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  moderate: "MEDIUM",
  low: "LOW",
  info: "INFO",
  informational: "INFO",
}

export function mapSeverity(
  engineSeverity: string
): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  return SEVERITY_MAP[engineSeverity.toLowerCase()] ?? "INFO"
}

export function generateDedupeKey(vuln: EngineVulnerability, targetId: string): string {
  const location = vuln.code_locations?.[0]
  const dependency = vuln.dependency_metadata
  // dependency_metadata values are typed unions in the 1.1 contract; package
  // identity fields are only meaningful when they are strings.
  const packageName =
    typeof dependency?.package_name === "string" ? dependency.package_name : undefined
  const packageEcosystem =
    typeof dependency?.package_ecosystem === "string" ? dependency.package_ecosystem : undefined
  // OSV advisories are not always assigned a CVE. The OSV id is still stable,
  // so use it together with the resolved package identity for every dependency
  // scanner rather than letting SCA and AI-03 duplicate the same advisory.
  const isDependencyFinding = Boolean(
    packageName &&
    (vuln.finding_class === "dependency_cve" || vuln.finding_class === "dependency_advisory")
  )
  return computeDedupeKey(
    isDependencyFinding
      ? {
          cve: vuln.cve,
          id: vuln.id,
          dependency: {
            packageEcosystem,
            packageName,
          },
        }
      : {
          findingClass: vuln.finding_class,
          cve: vuln.cve,
          cwe: vuln.cwe,
          endpoint: vuln.endpoint,
          method: vuln.method,
          file: location?.file,
          startLine: location?.start_line,
          endLine: location?.end_line,
          title: vuln.title,
        },
    targetId
  )
}

export function buildFindingSummary(vuln: EngineVulnerability): string {
  const parts: string[] = []
  if (vuln.endpoint) parts.push(`Endpoint: ${vuln.endpoint}`)
  if (vuln.method) parts.push(`Method: ${vuln.method}`)
  if (vuln.cwe) parts.push(`CWE: ${vuln.cwe}`)
  if (vuln.cve) parts.push(`CVE: ${vuln.cve}`)
  if (vuln.description) parts.push(vuln.description.slice(0, 200))
  return parts.join(" — ") || vuln.title
}
