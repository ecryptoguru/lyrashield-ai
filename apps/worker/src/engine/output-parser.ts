import { createHash } from "crypto"
import { logger } from "@lyrashield/logger"

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
  poc_description?: string
  poc_script_code?: string
  remediation_steps?: string
  control_ids?: number[]
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
  scannerSource?: "engine" | "sca" | "secrets" | "url" | "agent_config"
}

export interface EngineRunRecord {
  run_id: string
  run_name: string | null
  start_time: string
  end_time: string | null
  status: string
  targets_info?: unknown[]
  llm_usage?: Record<string, unknown>
  scan_results?: Record<string, unknown>
}

export interface ParsedScanOutput {
  vulnerabilities: EngineVulnerability[]
  runRecord: EngineRunRecord | null
  summary: string
  findingCount: number
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

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT_FIELD_LENGTH ? value : undefined
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

function validateControlIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_IDS) return undefined
  const controlIds = [
    ...new Set(
      value.filter(
        (candidate): candidate is number =>
          typeof candidate === "number" &&
          Number.isInteger(candidate) &&
          candidate >= 1 &&
          candidate <= 50
      )
    ),
  ]
  return controlIds.length > 0 ? controlIds : undefined
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

function normalizeLlmUsage(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const requests = findUsageMetric(
    record,
    new Set(["request_count", "requests_count", "requests"]),
    usageInteger
  )
  const requestCount =
    requests ?? (Array.isArray(record.requests) ? usageInteger(record.requests.length) : undefined)
  const inputTokens = findUsageMetric(
    record,
    new Set(["input_tokens", "prompt_tokens", "input_token_count"]),
    usageInteger
  )
  const cachedInputTokens = findUsageMetric(
    record,
    new Set(["cached_input_tokens", "cached_tokens"]),
    usageInteger
  )
  const outputTokens = findUsageMetric(
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
  const totalCostUsd = findUsageMetric(
    record,
    new Set(["total_cost_usd", "cost_usd", "total_cost", "cost"]),
    usageCost
  )
  const normalized = {
    ...(requestCount !== undefined ? { request_count: requestCount } : {}),
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function validateVulnerability(v: Record<string, unknown>): EngineVulnerability | null {
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
    ...(boundedString(v.poc_description)
      ? { poc_description: boundedString(v.poc_description) }
      : {}),
    ...(boundedString(v.poc_script_code)
      ? { poc_script_code: boundedString(v.poc_script_code) }
      : {}),
    ...(boundedString(v.remediation_steps)
      ? { remediation_steps: boundedString(v.remediation_steps) }
      : {}),
    ...(validateControlIds(v.control_ids)
      ? { control_ids: validateControlIds(v.control_ids) }
      : {}),
    ...(validateCodeLocations(v.code_locations)
      ? { code_locations: validateCodeLocations(v.code_locations) }
      : {}),
  }
}

export function parseVulnerabilitiesJson(raw: string): EngineVulnerability[] {
  if (!raw.trim()) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) {
      logger.warn("vulnerabilities.json is not an array", { type: typeof data })
      return []
    }
    if (data.length > MAX_ENGINE_FINDINGS) {
      logger.warn("vulnerabilities.json exceeds finding limit", { count: data.length })
      return []
    }
    const validated: EngineVulnerability[] = []
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue
      const vuln = validateVulnerability(item as Record<string, unknown>)
      if (vuln) validated.push(vuln)
    }
    return validated
  } catch (err) {
    logger.error("Failed to parse vulnerabilities.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
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

    return {
      run_id: runId,
      run_name: boundedString(record.run_name) ?? null,
      start_time: boundedString(record.start_time) ?? "",
      end_time: boundedString(record.end_time) ?? null,
      status,
      ...(targetsInfo ? { targets_info: targetsInfo } : {}),
      ...(llmUsage ? { llm_usage: llmUsage } : {}),
    }
  } catch (err) {
    logger.error("Failed to parse run.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function parseEngineOutput(
  vulnerabilitiesRaw: string,
  runJsonRaw: string
): ParsedScanOutput {
  const vulnerabilities = parseVulnerabilitiesJson(vulnerabilitiesRaw)
  const runRecord = parseRunJson(runJsonRaw)

  const summary = runRecord?.status
    ? `Engine status: ${runRecord.status}. ${vulnerabilities.length} finding(s) reported.`
    : `Scan completed. ${vulnerabilities.length} finding(s) reported.`

  return {
    vulnerabilities,
    runRecord,
    summary,
    findingCount: vulnerabilities.length,
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
  const raw = [targetId, vuln.cwe ?? "", vuln.endpoint ?? "", vuln.method ?? "", vuln.title]
    .join("|")
    .toLowerCase()
  return createHash("sha256").update(raw).digest("hex").slice(0, 32)
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
