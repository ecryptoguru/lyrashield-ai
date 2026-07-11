import type { EngineVulnerability } from "./output-parser"
import { logger } from "@lyrashield/logger"

export interface NormalizedFinding extends EngineVulnerability {
  normalizedSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  normalizedCwe: string | null
  normalizedCvss: number | null
  confidenceScore: number
  falsePositiveRisk: "low" | "medium" | "high"
  dedupeKey: string
  enrichment: {
    cweName?: string
    cweCategory?: string
    owaspCategory?: string
    remediationPriority?: number
  }
}

const CWE_METADATA: Record<string, { name: string; category: string; owasp?: string }> = {
  "CWE-79": {
    name: "Cross-site Scripting (XSS)",
    category: "Injection",
    owasp: "A03:2021-Injection",
  },
  "CWE-89": { name: "SQL Injection", category: "Injection", owasp: "A03:2021-Injection" },
  "CWE-200": {
    name: "Information Exposure",
    category: "Information Disclosure",
    owasp: "A01:2021-Broken Access Control",
  },
  "CWE-209": {
    name: "Generation of Error Message with Sensitive Information",
    category: "Information Disclosure",
  },
  "CWE-306": {
    name: "Missing Authentication for Critical Function",
    category: "Authentication",
    owasp: "A07:2021-Identification and Authentication Failures",
  },
  "CWE-319": {
    name: "Cleartext Transmission of Sensitive Information",
    category: "Transport Security",
  },
  "CWE-538": {
    name: "File and Directory Information Exposure",
    category: "Information Disclosure",
  },
  "CWE-614": {
    name: "Sensitive Cookie in HTTPS Session Without Secure Attribute",
    category: "Session Management",
  },
  "CWE-693": {
    name: "Protection Mechanism Failure",
    category: "Security Configuration",
    owasp: "A05:2021-Security Misconfiguration",
  },
  "CWE-749": { name: "Exposed Dangerous Method or Function", category: "Security Configuration" },
  "CWE-787": { name: "Out-of-bounds Write", category: "Memory Safety" },
  "CWE-78": { name: "OS Command Injection", category: "Injection", owasp: "A03:2021-Injection" },
  "CWE-1004": { name: "Sensitive Cookie Without HttpOnly", category: "Session Management" },
  "CWE-1021": {
    name: "Improper Restriction of Rendered UI Layers or Frames",
    category: "Client-side Security",
  },
  "CWE-1275": {
    name: "Sensitive Cookie Without SameSite Attribute",
    category: "Session Management",
  },
  "CWE-942": { name: "Permissive Cross-domain Policy", category: "Access Control" },
  "CWE-352": {
    name: "Cross-Site Request Forgery (CSRF)",
    category: "Session Management",
    owasp: "A01:2021-Broken Access Control",
  },
  "CWE-434": {
    name: "Unrestricted Upload of File with Dangerous Type",
    category: "Input Validation",
    owasp: "A04:2021-Insecure Design",
  },
  "CWE-502": {
    name: "Deserialization of Untrusted Data",
    category: "Input Validation",
    owasp: "A08:2021-Software and Data Integrity Failures",
  },
  "CWE-22": {
    name: "Path Traversal",
    category: "Path Manipulation",
    owasp: "A01:2021-Broken Access Control",
  },
  "CWE-98": { name: "PHP File Inclusion", category: "Injection" },
  "CWE-444": { name: "HTTP Request Smuggling", category: "Protocol Manipulation" },
  "CWE-521": { name: "Weak Password Requirements", category: "Authentication" },
  "CWE-540": {
    name: "Information Exposure Through Source Code",
    category: "Information Disclosure",
  },
  "CWE-732": {
    name: "Incorrect Permission Assignment for Critical Resource",
    category: "Access Control",
  },
  "CWE-770": { name: "Allocation of Resources Without Limits", category: "Resource Management" },
  "CWE-1333": { name: "Inefficient Regular Expression Complexity", category: "ReDoS" },
}

const SEVERITY_PRIORITY: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
}

const FALSE_POSITIVE_PATTERNS = [
  {
    pattern: /test\s+(?:server|environment|endpoint)/i,
    reason: "Finding references a test environment",
  },
  { pattern: /localhost|127\.0\.0\.1|0\.0\.0\.0/i, reason: "Finding references localhost" },
  {
    pattern: /example\.com|example\.org|test\.local/i,
    reason: "Finding references example domain",
  },
  { pattern: /placeholder|dummy|fake|sample/i, reason: "Finding references placeholder data" },
]

export function assessFalsePositiveRisk(vuln: EngineVulnerability): "low" | "medium" | "high" {
  // Only check target and endpoint fields for false-positive patterns.
  // Checking title/description would filter legitimate findings that happen
  // to mention test/example domains in their analysis text.
  const text = [vuln.target, vuln.endpoint].filter(Boolean).join(" ")

  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.pattern.test(text)) {
      logger.debug("False positive pattern matched", {
        pattern: fp.pattern.source,
        reason: fp.reason,
        title: vuln.title,
      })
      return "high"
    }
  }

  if (!vuln.poc_description && !vuln.poc_script_code && !vuln.code_locations?.length) {
    return "medium"
  }

  return "low"
}

export function enrichCwe(cwe: string | undefined): {
  cweName?: string
  cweCategory?: string
  owaspCategory?: string
} {
  if (!cwe) return {}
  const normalized = cwe.toUpperCase().startsWith("CWE-") ? cwe.toUpperCase() : `CWE-${cwe}`
  const meta = CWE_METADATA[normalized]
  if (!meta) return {}
  return {
    cweName: meta.name,
    cweCategory: meta.category,
    owaspCategory: meta.owasp,
  }
}

export function calculateCvssFromSeverity(severity: string): number {
  const map: Record<string, number> = {
    critical: 9.5,
    high: 7.5,
    medium: 5.0,
    low: 2.5,
    info: 0.0,
  }
  return map[severity.toLowerCase()] ?? 0.0
}

export function calculateConfidenceScore(vuln: EngineVulnerability): number {
  let score = 0

  if (vuln.poc_script_code && vuln.poc_description) {
    score = 95
  } else if (vuln.poc_description) {
    score = 85
  } else if (vuln.code_locations?.some((loc) => loc.fix_before && loc.fix_after)) {
    score = 90
  } else if (vuln.code_locations?.length) {
    score = 70
  } else if (vuln.technical_analysis && vuln.impact) {
    score = 60
  } else if (vuln.cve || vuln.cwe) {
    score = 40
  } else {
    score = 20
  }

  if (vuln.cvss && vuln.cvss > 0) {
    score = Math.min(score + 5, 100)
  }

  return score
}

export function calculateRemediationPriority(
  severity: string,
  confidenceScore: number,
  falsePositiveRisk: string
): number {
  const severityScore = SEVERITY_PRIORITY[severity.toUpperCase()] ?? 0
  const fpPenalty = falsePositiveRisk === "high" ? -2 : falsePositiveRisk === "medium" ? -1 : 0
  const confidenceBonus = confidenceScore >= 80 ? 1 : 0
  return Math.max(0, severityScore + confidenceBonus + fpPenalty)
}

export function normalizeSeverity(
  engineSeverity: string
): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  const map: Record<string, "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"> = {
    critical: "CRITICAL",
    high: "HIGH",
    medium: "MEDIUM",
    moderate: "MEDIUM",
    low: "LOW",
    info: "INFO",
    informational: "INFO",
  }
  return map[engineSeverity.toLowerCase()] ?? "INFO"
}

export function normalizeCwe(cwe: string | undefined): string | null {
  if (!cwe) return null
  const trimmed = cwe.trim()
  if (trimmed.toUpperCase().startsWith("CWE-")) return trimmed.toUpperCase()
  if (/^\d+$/.test(trimmed)) return `CWE-${trimmed}`
  return trimmed.toUpperCase()
}

export function normalizeFindings(
  vulnerabilities: EngineVulnerability[],
  targetId: string,
  dedupeKeyFn: (vuln: EngineVulnerability, targetId: string) => string
): NormalizedFinding[] {
  const seen = new Map<string, NormalizedFinding>()

  for (const vuln of vulnerabilities) {
    const dedupeKey = dedupeKeyFn(vuln, targetId)
    const normalizedSeverity = normalizeSeverity(vuln.severity)
    const normalizedCwe = normalizeCwe(vuln.cwe)
    const confidenceScore = calculateConfidenceScore(vuln)
    const falsePositiveRisk = assessFalsePositiveRisk(vuln)
    const enrichment = enrichCwe(normalizedCwe ?? undefined)
    const remediationPriority = calculateRemediationPriority(
      normalizedSeverity,
      confidenceScore,
      falsePositiveRisk
    )
    const normalizedCvss = vuln.cvss ?? calculateCvssFromSeverity(vuln.severity)

    const normalized: NormalizedFinding = {
      ...vuln,
      normalizedSeverity,
      normalizedCwe,
      normalizedCvss,
      confidenceScore,
      falsePositiveRisk,
      dedupeKey,
      enrichment: {
        ...enrichment,
        remediationPriority,
      },
    }

    const existing = seen.get(dedupeKey)
    if (!existing) {
      seen.set(dedupeKey, normalized)
    } else {
      if (
        (SEVERITY_PRIORITY[normalized.normalizedSeverity] ?? 0) >
        (SEVERITY_PRIORITY[existing.normalizedSeverity] ?? 0)
      ) {
        seen.set(dedupeKey, normalized)
      } else if (
        (SEVERITY_PRIORITY[normalized.normalizedSeverity] ?? 0) ===
        (SEVERITY_PRIORITY[existing.normalizedSeverity] ?? 0)
      ) {
        if (confidenceScore > existing.confidenceScore) {
          seen.set(dedupeKey, normalized)
        }
      }
    }
  }

  const results = Array.from(seen.values()).sort(
    (a, b) =>
      (SEVERITY_PRIORITY[b.normalizedSeverity] ?? 0) -
      (SEVERITY_PRIORITY[a.normalizedSeverity] ?? 0)
  )

  logger.info("Findings normalized", {
    input: vulnerabilities.length,
    output: results.length,
    duplicatesRemoved: vulnerabilities.length - results.length,
  })

  return results
}

export function filterFalsePositives(findings: NormalizedFinding[]): NormalizedFinding[] {
  const filtered = findings.filter((f) => f.falsePositiveRisk !== "high")
  const removed = findings.length - filtered.length
  if (removed > 0) {
    logger.info("False positives filtered", { removed, remaining: filtered.length })
  }
  return filtered
}

export function getFindingStats(findings: NormalizedFinding[]): {
  total: number
  bySeverity: Record<string, number>
  byConfidence: { high: number; medium: number; low: number }
  verified: number
  unverified: number
  falsePositiveRisk: { low: number; medium: number; high: number }
} {
  const bySeverity: Record<string, number> = {}
  const byConfidence = { high: 0, medium: 0, low: 0 }
  const fpRisk = { low: 0, medium: 0, high: 0 }

  for (const f of findings) {
    bySeverity[f.normalizedSeverity] = (bySeverity[f.normalizedSeverity] ?? 0) + 1
    if (f.confidenceScore >= 80) byConfidence.high++
    else if (f.confidenceScore >= 50) byConfidence.medium++
    else byConfidence.low++
    fpRisk[f.falsePositiveRisk]++
  }

  return {
    total: findings.length,
    bySeverity,
    byConfidence,
    verified: findings.filter((f) => f.confidenceScore >= 50).length,
    unverified: findings.filter((f) => f.confidenceScore < 50).length,
    falsePositiveRisk: fpRisk,
  }
}
