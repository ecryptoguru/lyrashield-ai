import { createHash } from "crypto"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "./output-parser"

export interface DependencyVulnerability {
  package: string
  version: string
  ecosystem: "npm" | "pypi" | "maven" | "go" | "composer" | "gem" | "nuget" | "cargo"
  severity: string
  cve?: string
  cwe?: string
  cvss?: number
  vulnerableVersions?: string
  patchedVersion?: string
  description?: string
  advisoryUrl?: string
  dependencyPath?: string
  isDevDependency?: boolean
}

export interface ScaScanResult {
  vulnerabilities: DependencyVulnerability[]
  totalScanned: number
  vulnerableCount: number
  ecosystem: string
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

export function normalizeScaFinding(
  dep: DependencyVulnerability,
  targetId: string,
): EngineVulnerability {
  const title = `Vulnerable dependency: ${dep.package}@${dep.version}`
  const severity = dep.severity.toLowerCase()

  return {
    id: createHash("sha256")
      .update(`${targetId}|sca|${dep.package}|${dep.version}|${dep.cve ?? ""}`)
      .digest("hex")
      .slice(0, 32),
    title,
    severity,
    timestamp: new Date().toISOString(),
    target: dep.package,
    cve: dep.cve,
    cwe: dep.cwe ?? "CWE-1035", // Deprecated/Outdated Components
    cvss: dep.cvss,
    description: dep.description ?? `Vulnerable package ${dep.package} at version ${dep.version}`,
    impact: dep.cve
      ? `CVE ${dep.cve}: ${dep.description ?? "Known vulnerability in dependency"}`
      : `Vulnerable dependency detected: ${dep.package}@${dep.version}`,
    technical_analysis: `Package: ${dep.package}\nVersion: ${dep.version}\nEcosystem: ${dep.ecosystem}\n${dep.vulnerableVersions ? `Vulnerable versions: ${dep.vulnerableVersions}\n` : ""}${dep.patchedVersion ? `Patched in: ${dep.patchedVersion}\n` : ""}${dep.dependencyPath ? `Dependency path: ${dep.dependencyPath}\n` : ""}${dep.advisoryUrl ? `Advisory: ${dep.advisoryUrl}` : ""}`,
    remediation_steps: dep.patchedVersion
      ? `Update ${dep.package} to version ${dep.patchedVersion} or later. Run: ${getUpdateCommand(dep.ecosystem, dep.package)}`
      : `Review the advisory for ${dep.package} and update to the latest secure version. ${dep.advisoryUrl ? `See: ${dep.advisoryUrl}` : ""}`,
    code_locations: dep.dependencyPath
      ? [{ file: dep.dependencyPath, label: "Dependency manifest" }]
      : undefined,
  }
}

function getUpdateCommand(ecosystem: string, pkg: string): string {
  switch (ecosystem) {
    case "npm":
      return `npm update ${pkg} || pnpm update ${pkg}`
    case "pypi":
      return `pip install --upgrade ${pkg}`
    case "maven":
      return `mvn versions:use-latest-versions -Dincludes=${pkg}`
    case "go":
      return `go get ${pkg}@latest`
    case "composer":
      return `composer update ${pkg}`
    case "gem":
      return `bundle update ${pkg}`
    case "nuget":
      return `dotnet add package ${pkg}`
    case "cargo":
      return `cargo update ${pkg}`
    default:
      return `Update ${pkg} to the latest version`
  }
}

export function parseScaOutput(raw: string): DependencyVulnerability[] {
  if (!raw.trim()) return []

  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) {
      logger.warn("SCA output is not an array", { type: typeof data })
      return []
    }

    return data.filter(
      (d): d is DependencyVulnerability =>
        typeof d === "object" &&
        d !== null &&
        typeof d.package === "string" &&
        typeof d.version === "string",
    )
  } catch (err) {
    logger.error("Failed to parse SCA output", {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

export function sortBySeverity(vulns: DependencyVulnerability[]): DependencyVulnerability[] {
  return [...vulns].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity.toLowerCase()] ?? 0
    const sb = SEVERITY_ORDER[b.severity.toLowerCase()] ?? 0
    return sb - sa
  })
}

export function deduplicateScaFindings(vulns: DependencyVulnerability[]): DependencyVulnerability[] {
  const seen = new Set<string>()
  const result: DependencyVulnerability[] = []

  for (const v of vulns) {
    const key = `${v.package}|${v.cve ?? ""}|${v.version}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(v)
    }
  }

  return result
}
