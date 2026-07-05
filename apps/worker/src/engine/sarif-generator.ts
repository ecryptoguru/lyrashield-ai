import type {
  SarifReport,
  SarifRun,
  SarifRule,
  SarifResult,
  FindingSeverity,
} from "@lyrashield/types"

interface FindingForSarif {
  id: string
  title: string
  summary: string
  severity: FindingSeverity
  cwe?: string | null
  cve?: string | null
  sarifRuleId?: string | null
  cvssScore?: number | null
  cvssVector?: string | null
  cvss3Score?: number | null
  cvss3Vector?: string | null
  verified: boolean
  technicalDetail?: string | null
  recommendedFix?: string | null
  businessImpact?: string | null
  target?: { name: string; url?: string | null; repoFullName?: string | null } | null
}

const SEVERITY_TO_LEVEL: Record<FindingSeverity, "error" | "warning" | "note" | "none"> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "note",
  INFO: "none",
}

export function generateSarifReport(
  findings: FindingForSarif[],
  toolInfo: { name: string; version?: string; informationUri?: string },
): SarifReport {
  const rules: Map<string, SarifRule> = new Map()
  const results: SarifResult[] = []

  for (const finding of findings) {
    const ruleId = finding.sarifRuleId || finding.cve || finding.cwe || `lyrasec-${finding.id.slice(0, 8)}`

    if (!rules.has(ruleId)) {
      const rule: SarifRule = {
        id: ruleId,
        name: finding.title,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.summary },
        defaultConfiguration: { level: SEVERITY_TO_LEVEL[finding.severity] },
        properties: {
          severity: finding.severity,
          verified: finding.verified,
          ...(finding.cwe ? { cwe: finding.cwe } : {}),
          ...(finding.cve ? { cve: finding.cve } : {}),
          ...(finding.cvssScore ? { cvssScore: finding.cvssScore } : {}),
          ...(finding.cvss3Score ? { cvss3Score: finding.cvss3Score } : {}),
        },
      }
      if (finding.cwe) {
        rule.helpUri = `https://cwe.mitre.org/data/definitions/${finding.cwe.replace("CWE-", "")}.html`
      }
      rules.set(ruleId, rule)
    }

    const result: SarifResult = {
      ruleId,
      level: SEVERITY_TO_LEVEL[finding.severity],
      message: {
        text: finding.businessImpact
          ? `${finding.summary}\n\nImpact: ${finding.businessImpact}`
          : finding.summary,
      },
      properties: {
        id: finding.id,
        verified: finding.verified,
        ...(finding.technicalDetail ? { technicalDetail: finding.technicalDetail } : {}),
        ...(finding.recommendedFix ? { remediation: finding.recommendedFix } : {}),
      },
    }

    if (finding.target) {
      result.locations = [
        {
          physicalLocation: {
            artifactLocation: {
              uri: finding.target.repoFullName ?? finding.target.url ?? finding.target.name,
            },
          },
        },
      ]
    }

    results.push(result)
  }

  const run: SarifRun = {
    tool: {
      driver: {
        name: toolInfo.name,
        ...(toolInfo.version ? { version: toolInfo.version } : {}),
        ...(toolInfo.informationUri ? { informationUri: toolInfo.informationUri } : {}),
        rules: Array.from(rules.values()),
      },
    },
    results,
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [run],
  }
}
