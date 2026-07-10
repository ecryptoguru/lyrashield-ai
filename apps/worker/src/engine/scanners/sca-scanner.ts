/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { readFile, readdir } from "fs/promises"
import { basename, join, relative } from "path"
import { logger } from "@lyrashield/logger"
import type { EngineVulnerability } from "../output-parser"

export interface ScaScanConfig {
  repoPath: string
  workspaceDir: string
  fetchFn?: typeof fetch
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
    ranges?: Array<{ type: string; events: Array<{ introduced?: string; fixed?: string; last_affected?: string }> }>
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

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"])

async function findDependencyFiles(repoPath: string, directory = repoPath): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" })
    const found: string[] = []
    for (const entry of entries) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          found.push(...await findDependencyFiles(repoPath, fullPath))
        }
      } else if (entry.isFile() && DEP_FILE_PATTERNS.includes(entry.name)) {
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
        deps.push({ name: parts[1], version: parts[2].replace(/^v/, ""), ecosystem: "Go", filePath })
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
      deps.push({ name: match[1], version: (match[2] ?? "0").replace(/[\^~>=<]/g, ""), ecosystem: "RubyGems", filePath })
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

async function parseDependencyFile(filePath: string, repoPath: string): Promise<Dependency[]> {
  const fullPath = join(repoPath, filePath)
  try {
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
      default:
        return []
    }
  } catch {
    return []
  }
}

export async function queryOsv(dependency: Dependency, fetchFn?: typeof fetch): Promise<OsvVulnerability[]> {
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

    const data = await res.json() as { vulns?: OsvVulnerability[] }
    return data.vulns ?? []
  } catch (err) {
    logger.warn("OSV API query failed", { dep: dependency.name, error: err instanceof Error ? err.message : String(err) })
    return []
  }
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

export async function scanSca(config: ScaScanConfig): Promise<EngineVulnerability[]> {
  const { repoPath, fetchFn } = config
  logger.info("Starting SCA scan", { repoPath })

  const depFiles = await findDependencyFiles(repoPath)
  if (depFiles.length === 0) {
    logger.info("No dependency files found", { repoPath })
    return []
  }

  const allDeps: Dependency[] = []
  for (const file of depFiles) {
    const deps = await parseDependencyFile(file, repoPath)
    allDeps.push(...deps)
  }

  logger.info("Dependencies parsed", { total: allDeps.length, files: depFiles.length })

  const seenVulnIds = new Set<string>()
  const findings: EngineVulnerability[] = []

  for (const dep of allDeps) {
    const vulns = await queryOsv(dep, fetchFn)
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
        description: vuln.summary ?? `Vulnerability ${vuln.id} affects ${dep.name} version ${dep.version}`,
        technical_analysis: vuln.details?.slice(0, 500) ?? `The dependency ${dep.name}@${dep.version} is affected by ${vuln.id}.`,
        impact: `The package ${dep.name}@${dep.version} has a known vulnerability (${vuln.id}). If this package is used in a production code path, it may expose the application to attack.`,
        remediation_steps: fixedVersion
          ? `Upgrade ${dep.name} to version ${fixedVersion} or later. Update the dependency in ${dep.filePath}.`
          : `Review ${vuln.id} for ${dep.name}@${dep.version}. No fix version is available — consider replacing the dependency or applying a workaround.`,
        poc_description: `Check ${dep.name}@${dep.version} against the OSV database. Vulnerability ${vuln.id} is listed as affecting this version.`,
      })
    }
  }

  logger.info("SCA scan complete", { repoPath, findingCount: findings.length, depsScanned: allDeps.length })
  return findings
}
