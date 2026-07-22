import { createHash } from "crypto"
import { logger } from "@lyrashield/logger"
import { checkOutputSafety } from "@lyrashield/security"
import { engineRunRecordSchema, engineVulnerabilitySchema } from "./engine-output-schema"

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
  dependency_metadata?: Record<string, string>
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
  /** Every detector that independently produced the normalized finding. */
  corroboratingSources?: Array<"engine" | "sca" | "secrets" | "url" | "agent_config">
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
  engine_version?: string
  prompt_bundle_hash?: string
  model?: string
  reasoning_effort?: string
  max_output_tokens?: number
  max_agents?: number
  scan_mode?: string
  terminal_reason?: string
}

export interface ParsedScanOutput {
  vulnerabilities: EngineVulnerability[]
  runRecord: EngineRunRecord | null
  summary: string
  findingCount: number
  /** False when the engine did not provide a valid findings artifact. */
  findingsComplete: boolean
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
const MAX_METADATA_ENTRIES = 32
const MAX_LLM_USAGE_NODES = 500
const MAX_DB_INTEGER = 2_147_483_647
const MAX_DB_DECIMAL_12_6 = 1_000_000
const MAX_LLM_USAGE_REQUESTS = 10_000
const GPT_56_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000
const CONTROL_ID_TOKEN_PATTERN = /^-?\d+$/

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT_FIELD_LENGTH ? value : undefined
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
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
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
  return /(?:^|[/.-])gpt-5\.6-(?:sol|terra|luna)(?:$|[/.-])/.test(normalized) ? value : undefined
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
    const cachedInputTokens = detailInteger(record.input_tokens_details, "cached_tokens")
    const cacheWriteInputTokens = detailInteger(record.input_tokens_details, "cache_write_tokens")
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
  const fixEffort = boundedString(v.fix_effort)?.toLowerCase()
  const validFixEffort =
    fixEffort === "trivial" || fixEffort === "low" || fixEffort === "medium" || fixEffort === "high"
      ? fixEffort
      : undefined
  const cvssBreakdown = boundedStringRecord(v.cvss_breakdown)
  const dependencyMetadata = boundedStringRecord(v.dependency_metadata)
  const controlIds = validateControlIds(v.control_ids)
  const codeLocations = validateCodeLocations(v.code_locations)

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
  }
}

function parseVulnerabilitiesArtifact(raw: string): {
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
      const vuln = validateVulnerability(item as Record<string, unknown>)
      if (!vuln) continue
      // Strict schema contract: reject anything that survived coercion but
      // still violates the expected shape or value bounds.
      const parsed = engineVulnerabilitySchema.safeParse(vuln)
      if (!parsed.success) {
        logger.warn("Engine output: vulnerability failed strict schema validation", {
          id: vuln.id,
          errors: parsed.error.issues.map((issue) => issue.message),
        })
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
    const maxOutputTokens = usageInteger(record.max_output_tokens)
    const maxAgents = usageInteger(record.max_agents)

    const runRecord: EngineRunRecord = {
      run_id: runId,
      run_name: boundedString(record.run_name) ?? null,
      start_time: boundedString(record.start_time) ?? "",
      end_time: boundedString(record.end_time) ?? null,
      status,
      ...(targetsInfo ? { targets_info: targetsInfo } : {}),
      ...(llmUsage ? { llm_usage: llmUsage } : {}),
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
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(maxAgents !== undefined ? { max_agents: maxAgents } : {}),
      ...(boundedString(record.scan_mode) ? { scan_mode: boundedString(record.scan_mode) } : {}),
      ...(boundedString(record.terminal_reason)
        ? { terminal_reason: boundedString(record.terminal_reason) }
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

    return runRecord
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
  const parsedVulnerabilities = parseVulnerabilitiesArtifact(vulnerabilitiesRaw)
  const vulnerabilities = parsedVulnerabilities.vulnerabilities
  const runRecord = parseRunJson(runJsonRaw)

  const summary = runRecord?.status
    ? `Engine status: ${runRecord.status}. ${vulnerabilities.length} finding(s) reported.`
    : `Scan completed. ${vulnerabilities.length} finding(s) reported.`

  return {
    vulnerabilities,
    runRecord,
    summary,
    findingCount: vulnerabilities.length,
    findingsComplete: parsedVulnerabilities.complete,
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
  const isDependencyFinding = Boolean(vuln.cve && dependency?.package_name)
  const identity = isDependencyFinding
    ? ["dependency", vuln.cve, dependency?.package_ecosystem ?? "", dependency?.package_name ?? ""]
    : [
        vuln.finding_class ?? "dynamic",
        vuln.cve ?? "",
        vuln.cwe ?? "",
        vuln.endpoint ?? "",
        vuln.method ?? "",
        location?.file ?? "",
        location?.start_line ?? "",
        location?.end_line ?? "",
        vuln.title,
      ]
  const raw = ["v2", targetId, ...identity]
    .map((value) => String(value).trim().toLowerCase())
    .join("|")
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
