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

export function parseVulnerabilitiesJson(raw: string): EngineVulnerability[] {
  if (!raw.trim()) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) {
      logger.warn("vulnerabilities.json is not an array", { type: typeof data })
      return []
    }
    return data.filter((v): v is EngineVulnerability =>
      typeof v === "object" && v !== null && typeof v.id === "string"
    )
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
    return data as EngineRunRecord
  } catch (err) {
    logger.error("Failed to parse run.json", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function parseEngineOutput(
  vulnerabilitiesRaw: string,
  runJsonRaw: string,
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
  low: "LOW",
  info: "INFO",
}

export function mapSeverity(engineSeverity: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  return SEVERITY_MAP[engineSeverity.toLowerCase()] ?? "INFO"
}

export function generateDedupeKey(vuln: EngineVulnerability, targetId: string): string {
  const raw = [
    targetId,
    vuln.cwe ?? "",
    vuln.endpoint ?? "",
    vuln.method ?? "",
    vuln.title,
  ].join("|").toLowerCase()
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
