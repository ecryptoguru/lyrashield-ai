import { logger } from "@lyrashield/logger"
import { checkOutputSafety, computeDedupeKey } from "@lyrashield/security"
import {
  engineVulnerabilitySchema,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_NESTED_ENTRIES,
  MAX_METADATA_NESTED_VALUE_CHARS,
  MAX_METADATA_VALUE_CHARS,
} from "./engine-output-schema"
import { boundedString, recordIngestionIssue, MAX_DB_INTEGER } from "./output-parser-common"
import {
  evidenceString,
  parseAdvisoryCvss,
  parseEngineConfidence,
  parseEvidenceWarnings,
  parseFixVerification,
  parseHttpExchangeIds,
  parseUpdateHistory,
  type EvidenceIngestionContext,
} from "./output-parser-evidence"
import type { EngineMetadataValue, EngineVulnerability } from "./output-parser-types"

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
const MAX_CODE_LOCATIONS = 100
const MAX_CONTROL_IDS = 10
const CONTROL_ID_TOKEN_PATTERN = /^-?\d+$/
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

export function parseVulnerabilitiesArtifact(
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
