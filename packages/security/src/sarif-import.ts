/**
 * SARIF 2.1.0 ingestion — normalizes third-party scan results into
 * Finding-ready records tagged scannerSource "external_import".
 *
 * Honesty rules:
 *  - Imported findings are third-party detections. They get
 *    verificationStatus DETECTED with method SCANNER_DETECTION, never
 *    VALIDATED — only a LyraShield deterministic retest can validate them.
 *  - They never count toward required coverage (no family receipt).
 *  - Re-importing the same results is idempotent via dedupeKey.
 */
import { computeDedupeKey } from "./finding-dedupe"

export const SARIF_IMPORT_VERSION = "sarif-import/1.0.0" as const

const MAX_SARIF_BYTES = 5 * 1024 * 1024
const MAX_RESULTS = 2_000

export interface SarifParseResult {
  toolName: string | null
  toolVersion: string | null
  resultCount: number
  rejected: number
  findings: ImportedFindingRecord[]
}

export interface ImportedFindingRecord {
  dedupeKey: string
  title: string
  summary: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  cwe: string | null
  owaspCategory: string | null
  sarifRuleId: string | null
  file: string | null
  startLine: number | null
  toolName: string | null
  /** Raw SARIF result, retained as the candidate payload. */
  payload: Record<string, unknown>
}

type SarifLevel = "error" | "warning" | "note" | "none"

const LEVEL_TO_SEVERITY: Record<SarifLevel, ImportedFindingRecord["severity"]> = {
  error: "HIGH",
  warning: "MEDIUM",
  note: "LOW",
  none: "INFO",
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string }
  region?: { startLine?: number; endLine?: number }
}

interface SarifResultItem {
  ruleId?: string
  ruleIndex?: number
  level?: SarifLevel
  message?: { text?: string; markdown?: string }
  locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>
  properties?: Record<string, unknown>
}

interface SarifDoc {
  version?: string
  runs?: Array<{
    tool?: {
      driver?: {
        name?: string
        version?: string
        rules?: Array<{ id?: string; properties?: Record<string, unknown> }>
      }
    }
    results?: SarifResultItem[]
  }>
}

function cweFromResult(
  result: SarifResultItem,
  ruleProps: Record<string, unknown> | undefined
): string | null {
  const candidates = [
    result.properties?.cwe,
    result.properties?.["cwe.id"],
    ruleProps?.cwe,
    ruleProps?.["cwe.id"],
    Array.isArray(ruleProps?.tags)
      ? (ruleProps.tags as unknown[]).find((t) => typeof t === "string" && /CWE-\d+/i.test(t))
      : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const m = /CWE-?\d+/i.exec(candidate)
      if (m) return `CWE-${m[0].replace(/CWE-?/i, "")}`
      // Some tools emit the bare numeric form (properties.cwe: "798").
      if (/^\d+$/.test(candidate.trim())) return `CWE-${candidate.trim()}`
    }
    if (typeof candidate === "number") return `CWE-${candidate}`
    if (Array.isArray(candidate) && candidate.length > 0) {
      const m = /CWE-?\d+/i.exec(String(candidate[0]))
      if (m) return `CWE-${m[0].replace(/CWE-?/i, "")}`
    }
  }
  return null
}

/** Extract an OWASP Top-10/LLM category tag ("A01", "API3", "LLM07") from
 *  rule/result properties and tags that tools like Semgrep/OWASP emit. */
function owaspFromResult(
  result: SarifResultItem,
  ruleProps: Record<string, unknown> | undefined
): string | null {
  const pools = [result.properties, ruleProps]
  for (const pool of pools) {
    if (!pool) continue
    const values: unknown[] = [
      pool.owasp,
      pool["owasp.category"],
      ...(Array.isArray(pool.tags) ? (pool.tags as unknown[]) : []),
    ]
    for (const value of values) {
      if (typeof value !== "string") continue
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded alternation over fixed category ids; no catastrophic backtracking
      const m = /\b(?:OWASP[\s_-]*)?(A(?:0[1-9]|10)|API(?:[1-9]|10)|LLM(?:0[1-9]|10))\b/i.exec(
        value
      )
      if (m?.[1]) return m[1].toUpperCase()
    }
  }
  return null
}

export function parseSarifReport(
  body: unknown,
  targetId: string
): SarifParseResult | { error: string } {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  if (Buffer.byteLength(raw) > MAX_SARIF_BYTES) {
    return { error: "SARIF payload exceeds the 5 MiB limit" }
  }
  let doc: SarifDoc
  try {
    doc = (typeof body === "string" ? JSON.parse(body) : body) as SarifDoc
  } catch {
    return { error: "Body is not valid JSON" }
  }
  if (!doc || doc.version !== "2.1.0" || !Array.isArray(doc.runs)) {
    return { error: "Payload is not a SARIF 2.1.0 report" }
  }

  const findings: ImportedFindingRecord[] = []
  let rejected = 0
  let toolName: string | null = null
  let toolVersion: string | null = null
  let resultCount = 0

  for (const run of doc.runs) {
    const driver = run.tool?.driver
    toolName = toolName ?? driver?.name ?? null
    toolVersion = toolVersion ?? driver?.version ?? null
    const rules = driver?.rules ?? []
    for (const result of run.results ?? []) {
      resultCount++
      if (findings.length >= MAX_RESULTS) {
        rejected++
        continue
      }
      const ruleId =
        result.ruleId ?? (result.ruleIndex != null ? rules[result.ruleIndex]?.id : undefined)
      const ruleProps = ruleId ? rules.find((r) => r.id === ruleId)?.properties : undefined
      const message = result.message?.text ?? result.message?.markdown
      if (!message && !ruleId) {
        rejected++
        continue
      }
      const location = result.locations?.[0]?.physicalLocation
      const file = location?.artifactLocation?.uri ?? null
      const startLine = location?.region?.startLine ?? null
      const title = `${ruleId ?? "external-rule"}${file ? ` in ${file}` : ""}`
      const cwe = cweFromResult(result, ruleProps)
      const severity = LEVEL_TO_SEVERITY[result.level ?? "warning"]
      findings.push({
        dedupeKey: computeDedupeKey(
          {
            findingClass: "external_import",
            cwe,
            file,
            startLine,
            endLine: location?.region?.endLine ?? null,
            title: `${ruleId ?? "external"}:${(message ?? "").slice(0, 80)}`,
          },
          targetId
        ),
        title,
        summary: (message ?? "").slice(0, 2000),
        severity,
        cwe,
        owaspCategory: owaspFromResult(result, ruleProps),
        sarifRuleId: ruleId ?? null,
        file,
        startLine,
        toolName,
        payload: {
          sarifResult: result,
          toolName,
          toolVersion,
          importVersion: SARIF_IMPORT_VERSION,
        },
      })
    }
  }

  return { toolName, toolVersion, resultCount, rejected, findings }
}

/** Back-compat alias — the route consumes records directly. */
export const sarifToFindingRecords = parseSarifReport
