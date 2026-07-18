/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { basename, join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"
import { fetchThreatSignals, type ThreatSignal } from "./threat-intelligence"

export interface ScaScanConfig {
  repoPath: string
  workspaceDir: string
  fetchFn?: typeof fetch
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("SCA scan cancelled")
}

interface Dependency {
  name: string
  version: string
  ecosystem: string
  filePath: string
}

interface OsvVulnerability {
  id: string
  summary?: string
  details?: string
  severity?: Array<{ type: string; score: string }>
  references?: Array<{ url: string }>
  affected?: Array<{
    package?: { name: string; ecosystem: string }
    ranges?: Array<{
      type: string
      events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>
    }>
  }>
  database_specific?: { severity?: string; cvss?: { vectorString?: string } }
}

const DEP_FILE_PATTERNS = [
  "package.json",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
]

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
])
const MAX_WALK_ENTRIES = 50_000
const MAX_WALK_DEPTH = 40
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_POM_DEPENDENCY_BLOCKS = 5_000

async function findDependencyFiles(
  repoPath: string,
  directory = repoPath,
  state = { entries: 0 },
  depth = 0,
  coverageIssues?: ScannerCoverageIssue[],
  signal?: AbortSignal
): Promise<string[]> {
  throwIfAborted(signal)
  if (depth > MAX_WALK_DEPTH || state.entries >= MAX_WALK_ENTRIES) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "bounded",
      reason: "Dependency-manifest discovery reached its bounded repository walk limit",
    })
    return []
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    const found: string[] = []
    for (const entry of entries) {
      throwIfAborted(signal)
      if (++state.entries > MAX_WALK_ENTRIES) break
      const fullPath = join(directory, entry.name)
      let entryStat
      try {
        entryStat = await lstat(fullPath)
      } catch {
        continue
      }
      if (entryStat.isSymbolicLink()) continue
      if (entryStat.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          found.push(
            ...(await findDependencyFiles(
              repoPath,
              fullPath,
              state,
              depth + 1,
              coverageIssues,
              signal
            ))
          )
        }
      } else if (entryStat.isFile() && DEP_FILE_PATTERNS.includes(entry.name)) {
        found.push(relative(repoPath, fullPath))
      }
    }
    return found
  } catch {
    return []
  }
}

function parsePackageJson(content: string, filePath: string): Dependency[] {
  try {
    const pkg = JSON.parse(content)
    const deps: Dependency[] = []
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    for (const section of sections) {
      const sectionDeps = pkg[section]
      if (sectionDeps && typeof sectionDeps === "object") {
        for (const [name, version] of Object.entries(sectionDeps)) {
          if (typeof version === "string") {
            const cleanVersion = version.replace(/[\^~>=<]/g, "").split(" ")[0]
            if (cleanVersion) {
              deps.push({ name, version: cleanVersion, ecosystem: "npm", filePath })
            }
          }
        }
      }
    }
    return deps
  } catch {
    logger.warn("Failed to parse package.json", { filePath })
    return []
  }
}

function parseRequirementsTxt(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = []
  const lines = content.split("\n")
  const pattern = /^([a-zA-Z0-9_-]+)\s*([=<>!~]+\s*)?([0-9][a-zA-Z0-9.\-+]*)/
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue
    const match = pattern.exec(trimmed)
    if (match && match[1]) {
      deps.push({
        name: match[1].toLowerCase(),
        version: match[3] ?? "0",
        ecosystem: "PyPI",
        filePath,
      })
    }
  }
  return deps
}

function parseGoMod(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = []
  const lines = content.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("require ")) {
      const parts = trimmed.split(/\s+/)
      if (parts.length >= 3 && parts[1] && parts[2]) {
        deps.push({
          name: parts[1],
          version: parts[2].replace(/^v/, ""),
          ecosystem: "Go",
          filePath,
        })
      }
    }
  }
  return deps
}

function parseCargoToml(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = []
  const lines = content.split("\n")
  let inDepsSection = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[(?:dev-|build-|optional-)?dependencies/.test(trimmed)) {
      inDepsSection = true
      continue
    }
    if (trimmed.startsWith("[")) {
      inDepsSection = false
      continue
    }
    if (inDepsSection && trimmed.includes("=")) {
      const match = /^([a-zA-Z0-9_-]+)\s*=\s*"([0-9][^"]*)"/.exec(trimmed)
      if (match && match[1] && match[2]) {
        deps.push({ name: match[1], version: match[2], ecosystem: "crates.io", filePath })
      }
    }
  }
  return deps
}

function parseGemfile(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = []
  const lines = content.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    const match = /^(?:gem|dependency)\s+["']([^"']+)["']\s*,?\s*["']?([^"']*)?["']?/.exec(trimmed)
    if (match && match[1]) {
      deps.push({
        name: match[1],
        version: (match[2] ?? "0").replace(/[\^~>=<]/g, ""),
        ecosystem: "RubyGems",
        filePath,
      })
    }
  }
  return deps
}

function parseComposerJson(content: string, filePath: string): Dependency[] {
  try {
    const pkg = JSON.parse(content)
    const deps: Dependency[] = []
    const sections = ["require", "require-dev"]
    for (const section of sections) {
      const sectionDeps = pkg[section]
      if (sectionDeps && typeof sectionDeps === "object") {
        for (const [name, version] of Object.entries(sectionDeps)) {
          if (typeof version === "string") {
            const cleanVersion = version.replace(/[\^~>=<]/g, "").split(" ")[0]
            if (cleanVersion && name !== "php") {
              deps.push({ name, version: cleanVersion, ecosystem: "Packagist", filePath })
            }
          }
        }
      }
    }
    return deps
  } catch {
    logger.warn("Failed to parse composer.json", { filePath })
    return []
  }
}

interface XmlBlock {
  content: string
  start: number
  end: number
}

function findXmlBlocks(content: string, tag: string, maxBlocks: number): XmlBlock[] {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const blocks: XmlBlock[] = []
  let offset = 0
  while (blocks.length < maxBlocks) {
    const start = content.indexOf(open, offset)
    if (start < 0) break
    const contentStart = start + open.length
    const contentEnd = content.indexOf(close, contentStart)
    if (contentEnd < 0) break
    const end = contentEnd + close.length
    blocks.push({ content: content.slice(contentStart, contentEnd), start, end })
    offset = end
  }
  return blocks
}

function xmlTagValue(content: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = content.indexOf(open)
  if (start < 0) return undefined
  const valueStart = start + open.length
  const end = content.indexOf(close, valueStart)
  return end < 0 ? undefined : content.slice(valueStart, end).trim() || undefined
}

function resolveMavenVersion(
  value: string | undefined,
  properties: XmlBlock | undefined
): string | undefined {
  if (!value) return undefined
  const property = /^\$\{([\w.-]+)\}$/.exec(value)?.[1]
  return property ? xmlTagValue(properties?.content ?? "", property) : value
}

function parsePomXml(
  content: string,
  filePath: string,
  coverageIssues?: ScannerCoverageIssue[]
): Dependency[] {
  const dependencies: Dependency[] = []
  const properties = findXmlBlocks(content, "properties", 1)[0]
  const dependencyManagement = findXmlBlocks(content, "dependencyManagement", 10)
  const managedRanges = dependencyManagement.map((block) => [block.start, block.end] as const)
  const managedVersions = new Map<string, string>()
  for (const management of dependencyManagement) {
    for (const block of findXmlBlocks(
      management.content,
      "dependency",
      MAX_POM_DEPENDENCY_BLOCKS
    )) {
      const groupId = xmlTagValue(block.content, "groupId")
      const artifactId = xmlTagValue(block.content, "artifactId")
      const version = resolveMavenVersion(xmlTagValue(block.content, "version"), properties)
      if (groupId && artifactId && version) managedVersions.set(`${groupId}:${artifactId}`, version)
    }
  }

  const blocks = findXmlBlocks(content, "dependency", MAX_POM_DEPENDENCY_BLOCKS)
  const remainingDependency = content.indexOf("<dependency>", blocks.at(-1)?.end ?? 0)
  if (blocks.length === MAX_POM_DEPENDENCY_BLOCKS && remainingDependency >= 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "bounded",
      subject: filePath,
      reason: `POM dependency parsing is limited to ${MAX_POM_DEPENDENCY_BLOCKS} blocks`,
    })
  } else if (remainingDependency >= 0) {
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "partial",
      subject: filePath,
      reason: "A malformed POM dependency block could not be parsed",
    })
  }
  for (const block of blocks) {
    if (managedRanges.some(([start, end]) => block.start >= start && block.end <= end)) continue
    const groupId = xmlTagValue(block.content, "groupId")
    const artifactId = xmlTagValue(block.content, "artifactId")
    const directVersion = xmlTagValue(block.content, "version")
    const version =
      resolveMavenVersion(directVersion, properties) ??
      managedVersions.get(`${groupId}:${artifactId}`)
    if (!groupId || !artifactId || !version) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        subject: filePath,
        reason: "A Maven dependency version could not be resolved from the local POM",
      })
      continue
    }
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      version,
      ecosystem: "Maven",
      filePath,
    })
  }
  return dependencies
}

function resolveGradleVersion(value: string, variables: Map<string, string>): string | undefined {
  const resolved = value.replace(
    /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (_match, braced, bare) => {
      return variables.get(braced ?? bare) ?? ""
    }
  )
  return resolved && !resolved.includes("$") ? resolved : undefined
}

function parseGradleVariables(content: string): Map<string, string> {
  const variables = new Map<string, string>()
  const assignment =
    /(?:^|\n)\s*(?:def|val|final\s+String)?\s*([A-Za-z_]\w*)\s*=\s*["']([^"']+)["']/g
  for (const match of content.matchAll(assignment)) {
    if (match[1] && match[2]) variables.set(match[1], match[2])
  }
  return variables
}

async function parseGradle(
  content: string,
  filePath: string,
  repoPath: string,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<Dependency[]> {
  const dependencies: Dependency[] = []
  const variables = parseGradleVariables(content)
  const pattern =
    /^\s*(?:api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(\s*)?["']([^:"']+):([^:"']+):([^"']+)["']/gm
  for (const match of content.matchAll(pattern)) {
    const [, groupId, artifactId, version] = match
    const resolvedVersion = version ? resolveGradleVersion(version, variables) : undefined
    if (!groupId || !artifactId || !resolvedVersion) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        subject: filePath,
        reason: "A Gradle dependency version could not be resolved from local assignments",
      })
      continue
    }
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      version: resolvedVersion,
      ecosystem: "Maven",
      filePath,
    })
  }

  const mapPattern =
    /^\s*(?:api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s+group:\s*["']([^"']+)["']\s*,\s*name:\s*["']([^"']+)["']\s*,\s*version:\s*["']?([^\s,'")]+)["']?/gm
  for (const match of content.matchAll(mapPattern)) {
    const [, groupId, artifactId, version] = match
    const resolvedVersion = version ? resolveGradleVersion(version, variables) : undefined
    if (!groupId || !artifactId || !resolvedVersion) continue
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      version: resolvedVersion,
      ecosystem: "Maven",
      filePath,
    })
  }

  const catalogCalls = content.matchAll(
    /(?:api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(\s*libs\.([A-Za-z0-9_.-]+)\s*\)/g
  )
  const catalogPath = join(repoPath, "gradle/libs.versions.toml")
  let catalog = ""
  try {
    catalog = await readFile(catalogPath, "utf8")
  } catch {
    // A catalog is optional unless the build file references one.
  }
  const versions = new Map<string, string>()
  const libraries = new Map<string, { module: string; versionRef: string }>()
  let section = ""
  for (const line of catalog.split("\n")) {
    const sectionMatch = /^\s*\[([^\]]+)]\s*$/.exec(line)
    if (sectionMatch?.[1]) {
      section = sectionMatch[1]
      continue
    }
    if (section === "versions") {
      const match = /^\s*([\w.-]+)\s*=\s*["']([^"']+)["']\s*$/.exec(line)
      if (match?.[1] && match[2]) versions.set(match[1], match[2])
    } else if (section === "libraries") {
      const match =
        /^\s*([\w.-]+)\s*=\s*\{\s*module\s*=\s*["']([^"']+)["']\s*,\s*version\.ref\s*=\s*["']([^"']+)["']\s*}\s*$/.exec(
          line
        )
      if (match?.[1] && match[2] && match[3]) {
        libraries.set(match[1], { module: match[2], versionRef: match[3] })
      }
    }
  }
  for (const match of catalogCalls) {
    const alias = match[1]?.replace(/\./g, "-")
    const library = alias ? libraries.get(alias) : undefined
    const version = library ? versions.get(library.versionRef) : undefined
    const [groupId, artifactId] = library?.module.split(":") ?? []
    if (!groupId || !artifactId || !version) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        subject: filePath,
        reason: "A Gradle version-catalog dependency could not be resolved locally",
      })
      continue
    }
    dependencies.push({ name: `${groupId}:${artifactId}`, version, ecosystem: "Maven", filePath })
  }
  return dependencies
}

async function parseDependencyFile(
  filePath: string,
  repoPath: string,
  coverageIssues?: ScannerCoverageIssue[]
): Promise<Dependency[]> {
  const fullPath = join(repoPath, filePath)
  try {
    const stat = await lstat(fullPath)
    if (stat.size > MAX_MANIFEST_BYTES) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "bounded",
        subject: filePath,
        reason: `Dependency manifest exceeds the ${MAX_MANIFEST_BYTES}-byte scanner limit`,
      })
      return []
    }
    const content = await readFile(fullPath, "utf-8")
    switch (basename(filePath)) {
      case "package.json":
        return parsePackageJson(content, filePath)
      case "requirements.txt":
        return parseRequirementsTxt(content, filePath)
      case "go.mod":
        return parseGoMod(content, filePath)
      case "Cargo.toml":
        return parseCargoToml(content, filePath)
      case "Gemfile":
        return parseGemfile(content, filePath)
      case "composer.json":
        return parseComposerJson(content, filePath)
      case "pom.xml":
        return parsePomXml(content, filePath, coverageIssues)
      case "build.gradle":
        return parseGradle(content, filePath, repoPath, coverageIssues)
      default:
        return []
    }
  } catch {
    return []
  }
}

export async function queryOsv(
  dependency: Dependency,
  fetchFn?: typeof fetch
): Promise<OsvVulnerability[]> {
  const url = "https://api.osv.dev/v1/query"
  const body = {
    package: { name: dependency.name, ecosystem: dependency.ecosystem },
    version: dependency.version,
  }
  const doFetch = fetchFn ?? fetch

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      logger.warn("OSV API returned non-OK status", { status: res.status, dep: dependency.name })
      return []
    }

    const data = (await res.json()) as { vulns?: OsvVulnerability[] }
    return data.vulns ?? []
  } catch (err) {
    logger.warn("OSV API query failed", {
      dep: dependency.name,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

export async function queryOsvBatch(
  dependencies: Dependency[],
  fetchFn?: typeof fetch,
  signal?: AbortSignal
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
      const data = (await response.json()) as { results?: Array<{ vulns?: OsvVulnerability[] }> }
      for (const [index, dependency] of chunk.entries()) {
        result.set(dependencyKey(dependency), data.results?.[index]?.vulns ?? [])
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("SCA scan cancelled")
      logger.warn("OSV batch query failed", {
        error: error instanceof Error ? error.message : String(error),
        dependencyCount: chunk.length,
      })
      for (const dependency of chunk) result.set(dependencyKey(dependency), [])
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
  const { repoPath, fetchFn, coverageIssues, signal } = config
  throwIfAborted(signal)
  logger.info("Starting SCA scan", { repoPath })

  const depFiles = await findDependencyFiles(
    repoPath,
    repoPath,
    { entries: 0 },
    0,
    coverageIssues,
    signal
  )
  if (depFiles.length === 0) {
    logger.info("No dependency files found", { repoPath })
    return []
  }

  const allDeps: Dependency[] = []
  for (const file of depFiles) {
    throwIfAborted(signal)
    const deps = await parseDependencyFile(file, repoPath, coverageIssues)
    allDeps.push(...deps)
  }

  const uniqueDeps = Array.from(new Map(allDeps.map((dep) => [dependencyKey(dep), dep])).values())
  logger.info("Dependencies parsed", {
    total: allDeps.length,
    unique: uniqueDeps.length,
    files: depFiles.length,
  })
  const osvResults = await queryOsvBatch(uniqueDeps, fetchFn, signal)

  const seenVulnIds = new Set<string>()
  const findings: EngineVulnerability[] = []

  for (const dep of uniqueDeps) {
    throwIfAborted(signal)
    const vulns = osvResults.get(dependencyKey(dep)) ?? []
    for (const vuln of vulns) {
      if (seenVulnIds.has(vuln.id)) continue
      seenVulnIds.add(vuln.id)

      const severity = mapOsvSeverity(vuln)
      const cve = extractCveId(vuln)
      const fixedVersion = extractFixedVersion(vuln)

      findings.push({
        id: vuln.id,
        title: `Vulnerable dependency: ${dep.name}@${dep.version} (${vuln.id})`,
        severity,
        timestamp: new Date().toISOString(),
        target: dep.filePath,
        cve,
        cwe: "CWE-1104", // Use of Unmaintained Third Party Components
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
    fetchFn ?? fetch,
    signal
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
