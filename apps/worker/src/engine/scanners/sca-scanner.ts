import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { hydrateOsvDetails, OsvVulnerabilitySchema, type AdvisoryBatchResult } from "@lyrashield/db"
import type { HostResolver } from "@lyrashield/security"
import type { EngineVulnerability } from "../output-parser"
import {
  recordCoverageIssue,
  type ScannerCoverageIssue,
  type ScannerDiscovery,
} from "../scanner-coverage"
import { fetchThreatSignals, type ThreatSignal } from "./threat-intelligence"
import type { ResolvedDependencyInventory } from "./resolved-dependencies"
import { collectScaDependencies, type Dependency } from "./dependency-manifests"

interface ScaScanConfig {
  repoPath: string
  workspaceDir: string
  fetchFn?: typeof fetch
  cisaFetchFn?: typeof fetch
  /** Injectable DNS resolver for safe-fetch tests. */
  cisaResolver?: HostResolver
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
  resolvedDependencyInventory?: ResolvedDependencyInventory
  advisoryBatch?: AdvisoryBatchResult
  discovery?: ScannerDiscovery
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("SCA scan cancelled")
}

type OsvVulnerability = z.infer<typeof OsvVulnerabilitySchema>

const osvEntrySchema = z.object({ vulns: z.array(z.unknown()).optional() })

function validatedAdvisoryEntry(
  value: unknown,
  subject: string,
  coverageIssues?: ScannerCoverageIssue[]
): OsvVulnerability[] | undefined {
  const parsed = osvEntrySchema.safeParse(value)
  if (!parsed.success) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "partial",
      subject,
      reason: "Advisory response did not resolve an exact dependency",
    })
    return undefined
  }
  const vulnerabilities: OsvVulnerability[] = []
  for (const candidate of parsed.data.vulns ?? []) {
    const vulnerability = OsvVulnerabilitySchema.safeParse(candidate)
    if (vulnerability.success) vulnerabilities.push(vulnerability.data)
    else
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        subject,
        reason: "Malformed advisory record was rejected; advisory coverage is incomplete",
      })
  }
  return vulnerabilities
}

async function queryOsvBatch(
  dependencies: Dependency[],
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<Map<string, OsvVulnerability[]>> {
  const result = new Map<string, OsvVulnerability[]>()
  const doFetch = fetchFn ?? fetch
  for (let start = 0; start < dependencies.length; start += 100) {
    throwIfAborted(signal)
    const chunk = dependencies.slice(start, start + 100)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await doFetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: chunk.map((dependency) => ({
            package: { name: dependency.name, ecosystem: dependency.ecosystem },
            version: dependency.version,
          })),
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`OSV API returned ${response.status}`)
      const data = (await response.json()) as {
        results?: Array<{ vulns?: OsvVulnerability[]; next_page_token?: unknown }>
      }
      const hydrated = await hydrateOsvDetails(
        (data.results ?? []).flatMap((row) => (Array.isArray(row?.vulns) ? row.vulns : [])),
        doFetch,
        controller.signal
      )
      const byId = new Map(hydrated.vulns.map((vulnerability) => [vulnerability.id, vulnerability]))
      for (const [index, dependency] of chunk.entries()) {
        const vulnerabilities = validatedAdvisoryEntry(
          data.results?.[index],
          dependency.filePath,
          coverageIssues
        )
        if (vulnerabilities)
          result.set(
            dependencyKey(dependency),
            vulnerabilities.map((vulnerability) => byId.get(vulnerability.id) ?? vulnerability)
          )
        if (hydrated.incomplete || data.results?.[index]?.next_page_token)
          recordCoverageIssue(coverageIssues, {
            scanner: "sca",
            status: "partial",
            subject: dependency.filePath,
            reason: "Advisory details or pagination coverage are incomplete",
          })
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("SCA scan cancelled")
      logger.warn("OSV batch query failed", {
        error: error instanceof Error ? error.message : String(error),
        dependencyCount: chunk.length,
      })
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        reason: "Advisory lookup failed; dependencies could not be fully assessed",
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }
  return result
}

function dependencyKey(dependency: Pick<Dependency, "name" | "version" | "ecosystem">): string {
  return `${dependency.ecosystem}:${dependency.name}@${dependency.version}`
}

function mapOsvSeverity(vuln: OsvVulnerability): string {
  const dbSeverity = vuln.database_specific?.severity?.toLowerCase()
  if (dbSeverity) {
    const map: Record<string, string> = {
      critical: "critical",
      high: "high",
      medium: "medium",
      moderate: "medium",
      low: "low",
    }
    if (map[dbSeverity]) return map[dbSeverity]
  }

  if (vuln.severity?.length) {
    for (const s of vuln.severity) {
      const score = parseFloat(s.score.match(/CVSS:3\.[01]\/[A-Z]:([0-9.]+)/)?.[1] ?? "0")
      if (score >= 9) return "critical"
      if (score >= 7) return "high"
      if (score >= 4) return "medium"
      if (score > 0) return "low"
    }
  }

  return "medium"
}

function extractCveId(vuln: OsvVulnerability): string | undefined {
  if (vuln.id.startsWith("CVE-")) return vuln.id
  return vuln.references?.find((r) => r.url.includes("CVE-"))?.url.match(/CVE-\d{4}-\d+/)?.[0]
}

function stableRelease(version: string, allowPartial = false): number[] | undefined {
  const parts = version.replace(/^v/, "").split(".")
  if (
    parts.length > 3 ||
    parts.length < (allowPartial ? 1 : 3) ||
    !parts.every((part) => /^\d{1,6}$/.test(part))
  )
    return undefined
  return [Number(parts[0]), Number(parts[1] ?? 0), Number(parts[2] ?? 0)]
}

function compareRelease(left: number[], right: number[]): number {
  for (let i = 0; i < 3; i++) {
    const delta = left[i]! - right[i]!
    if (delta) return delta
  }
  return 0
}
/** Only a fixed interval containing the exact installed Composer release is actionable. */
function composerFixedVersion(vuln: OsvVulnerability, dependency: Dependency): string | undefined {
  const installed = stableRelease(dependency.version)
  if (!installed) return undefined
  const fixes: string[] = []
  for (const affected of vuln.affected ?? []) {
    if (
      affected.package &&
      (affected.package.name !== dependency.name || affected.package.ecosystem !== "Packagist")
    )
      continue
    for (const range of affected.ranges ?? []) {
      if (range.type && !["SEMVER", "ECOSYSTEM"].includes(range.type)) continue
      let introduced: number[] | undefined = [0, 0, 0]
      for (const event of range.events) {
        if (event.introduced !== undefined)
          introduced = event.introduced === "0" ? [0, 0, 0] : stableRelease(event.introduced, true)
        if (event.fixed !== undefined) {
          const fixed = stableRelease(event.fixed)
          if (
            introduced &&
            fixed &&
            compareRelease(installed, introduced) >= 0 &&
            compareRelease(installed, fixed) < 0
          )
            fixes.push(event.fixed)
          introduced = undefined
        }
        if (event.last_affected !== undefined) introduced = undefined
      }
    }
  }
  return fixes.sort((left, right) => compareRelease(stableRelease(left)!, stableRelease(right)!))[0]
}

function extractFixedVersion(vuln: OsvVulnerability): string | undefined {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events) {
        if (event.fixed) return event.fixed
      }
    }
  }
  return undefined
}

function formatThreatPriority(signal: ThreatSignal | undefined): string | null {
  if (!signal) return null
  const parts: string[] = []
  if (signal.knownExploited) {
    parts.push(
      `CISA KEV: known exploited in the wild${signal.dateAdded ? `; cataloged ${signal.dateAdded}` : ""}${signal.dueDate ? `; federal remediation due ${signal.dueDate}` : ""}.`
    )
  }
  if (signal.epss !== undefined) {
    parts.push(
      `FIRST EPSS: ${(signal.epss * 100).toFixed(2)}% probability of exploitation activity in the next 30 days${signal.percentile !== undefined ? ` (${(signal.percentile * 100).toFixed(1)}th percentile)` : ""}${signal.epssDate ? ` as of ${signal.epssDate}` : ""}.`
    )
  }
  return parts.length > 0 ? `Threat priority — ${parts.join("\n")}` : null
}

export async function scanSca(config: ScaScanConfig): Promise<EngineVulnerability[]> {
  const {
    repoPath,
    fetchFn,
    cisaFetchFn,
    cisaResolver,
    coverageIssues,
    signal,
    resolvedDependencyInventory,
    advisoryBatch,
  } = config
  throwIfAborted(signal)
  logger.info("Starting SCA scan", { repoPath })

  const allDeps = await collectScaDependencies(config)

  const uniqueDeps = Array.from(
    new Map(
      allDeps.map((dep) => [
        dep.ecosystem === "Packagist"
          ? JSON.stringify([dependencyKey(dep), dep.filePath])
          : dependencyKey(dep),
        dep,
      ])
    ).values()
  )
  logger.info("Dependencies parsed", {
    total: allDeps.length,
    unique: uniqueDeps.length,
    sharedResolution: !!resolvedDependencyInventory,
  })
  const osvResults = resolvedDependencyInventory
    ? new Map<string, OsvVulnerability[]>()
    : await queryOsvBatch(
        [...new Map(uniqueDeps.map((dep) => [dependencyKey(dep), dep])).values()],
        fetchFn,
        signal,
        coverageIssues
      )

  if (resolvedDependencyInventory) {
    for (const result of advisoryBatch?.results ?? []) {
      const vulnerabilities = validatedAdvisoryEntry(
        result,
        result.package.filePath,
        coverageIssues
      )
      if (vulnerabilities) osvResults.set(dependencyKey(result.package), vulnerabilities)
    }
    for (const dep of uniqueDeps) {
      if (!osvResults.has(dependencyKey(dep)))
        recordCoverageIssue(coverageIssues, {
          scanner: "sca",
          status: "partial",
          subject: dep.filePath,
          reason: "Advisory batch did not resolve a valid exact dependency response",
        })
    }
  }

  const seenDependencyVulnerabilities = new Set<string>()
  const findings: EngineVulnerability[] = []

  for (const dep of uniqueDeps) {
    throwIfAborted(signal)
    const vulns = osvResults.get(dependencyKey(dep)) ?? []
    for (const vuln of vulns) {
      const dependencyVulnerabilityId = JSON.stringify([
        dependencyKey(dep),
        vuln.id,
        ...(dep.ecosystem === "Packagist" ? [dep.filePath] : []),
      ])
      if (seenDependencyVulnerabilities.has(dependencyVulnerabilityId)) continue
      seenDependencyVulnerabilities.add(dependencyVulnerabilityId)

      const severity = mapOsvSeverity(vuln)
      const cve = extractCveId(vuln)
      const fixedVersion =
        dep.ecosystem === "Packagist" ? composerFixedVersion(vuln, dep) : extractFixedVersion(vuln)

      findings.push({
        id: vuln.id,
        title: `Vulnerable dependency: ${dep.name}@${dep.version} (${vuln.id})`,
        severity,
        timestamp: new Date().toISOString(),
        target: dep.filePath,
        cve,
        cwe: "CWE-1104", // Use of Unmaintained Third Party Components
        finding_class: "dependency_cve",
        dependency_metadata: {
          package_name: dep.name,
          installed_version: dep.version,
          package_ecosystem: dep.ecosystem.toLowerCase(),
          ...(dep.ecosystem === "Packagist" ? { lockfile_path: dep.filePath } : {}),
          ...(fixedVersion ? { fixed_version: fixedVersion } : {}),
        },
        ...(dep.ecosystem === "Packagist"
          ? {
              code_locations: [
                {
                  file: dep.filePath,
                  label: `Resolved Composer package ${dep.name}@${dep.version}`,
                },
              ],
            }
          : {}),
        control_ids: [37],
        description:
          vuln.summary ?? `Vulnerability ${vuln.id} affects ${dep.name} version ${dep.version}`,
        technical_analysis:
          vuln.details?.slice(0, 500) ??
          `The dependency ${dep.name}@${dep.version} is affected by ${vuln.id}.`,
        impact: `The package ${dep.name}@${dep.version} has a known vulnerability (${vuln.id}). If this package is used in a production code path, it may expose the application to attack.`,
        remediation_steps: fixedVersion
          ? `Upgrade ${dep.name} to version ${fixedVersion} or later. Update the dependency in ${dep.filePath}.`
          : `Review ${vuln.id} for ${dep.name}@${dep.version}. No fix version is available — consider replacing the dependency or applying a workaround.`,
        poc_description: `Check ${dep.name}@${dep.version} against the OSV database. Vulnerability ${vuln.id} is listed as affecting this version.`,
      })
    }
  }

  const threatSignals = await fetchThreatSignals(
    findings.flatMap((finding) => (finding.cve ? [finding.cve] : [])),
    { fetchFn, cisaFetchFn, cisaResolver, signal }
  )
  const enrichedFindings = findings.map((finding) => {
    const priority = finding.cve ? formatThreatPriority(threatSignals.get(finding.cve)) : null
    return priority
      ? {
          ...finding,
          technical_analysis: `${finding.technical_analysis ?? ""}\n\n${priority}`.trim(),
        }
      : finding
  })
  logger.info("SCA scan complete", {
    repoPath,
    findingCount: enrichedFindings.length,
    depsScanned: uniqueDeps.length,
  })
  return enrichedFindings
}
