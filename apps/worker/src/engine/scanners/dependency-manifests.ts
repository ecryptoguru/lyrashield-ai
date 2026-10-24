/* eslint-disable security/detect-non-literal-fs-filename, security/detect-unsafe-regex */
import { lstat, readFile, readdir } from "fs/promises"
import { basename, join, relative } from "path"
import { logger } from "@lyrashield/logger"
import {
  recordCoverageIssue,
  type ScannerCoverageIssue,
  type ScannerDiscovery,
} from "../scanner-coverage"
import { resolveExactDependencies, type ResolvedDependencyInventory } from "./resolved-dependencies"
export interface Dependency {
  name: string
  version: string
  ecosystem: string
  filePath: string
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("SCA scan cancelled")
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
  "composer.lock",
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
        if (entry.name === "composer.json" || entry.name === "composer.lock")
          recordCoverageIssue(coverageIssues, {
            scanner: "sca",
            status: "partial",
            subject: relative(repoPath, fullPath),
            reason: "Composer dependency path could not be read",
          })
        continue
      }
      if (entryStat.isSymbolicLink()) {
        if (entry.name === "composer.json" || entry.name === "composer.lock") {
          recordCoverageIssue(coverageIssues, {
            scanner: "sca",
            status: "partial",
            subject: relative(repoPath, fullPath),
            reason: "Composer dependency path is a symbolic link and was not read",
          })
        }
        continue
      }
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
    recordCoverageIssue(coverageIssues, {
      scanner: "sca",
      status: "partial",
      subject: relative(repoPath, directory) || ".",
      reason: "Dependency-manifest directory could not be read",
    })
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

export async function collectScaDependencies(config: {
  repoPath: string
  coverageIssues?: ScannerCoverageIssue[]
  signal?: AbortSignal
  resolvedDependencyInventory?: ResolvedDependencyInventory
  advisoryBatch?: { status: string }
  discovery?: ScannerDiscovery
}): Promise<Dependency[]> {
  const {
    repoPath,
    coverageIssues,
    signal,
    resolvedDependencyInventory,
    advisoryBatch,
    discovery,
  } = config
  const allDeps: Dependency[] = []
  let manifestFiles = 0
  let manifestBytes = 0
  let emptyManifests = 0
  if (resolvedDependencyInventory) {
    manifestFiles = new Set([
      resolvedDependencyInventory.evidenceFile.path,
      ...resolvedDependencyInventory.packages.map((pkg) => pkg.filePath),
    ]).size
    manifestBytes = resolvedDependencyInventory.evidenceFile.size
    emptyManifests = resolvedDependencyInventory.status !== "COMPLETE" ? 1 : 0
    if (resolvedDependencyInventory.status !== "COMPLETE")
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: resolvedDependencyInventory.packages.length ? "partial" : "unsupported",
        reason: "Resolved dependency inventory is empty or incomplete",
      })
    for (const issue of resolvedDependencyInventory.unresolved)
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        subject: issue.name,
        reason: issue.reason,
      })
    if (!advisoryBatch || advisoryBatch.status !== "COMPLETE")
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "partial",
        reason: "Advisory batch is missing or incomplete",
      })
    allDeps.push(
      ...resolvedDependencyInventory.packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        ecosystem: pkg.ecosystem,
        filePath: pkg.filePath,
      }))
    )
  } else {
    const depFiles = await findDependencyFiles(
      repoPath,
      repoPath,
      { entries: 0 },
      0,
      coverageIssues,
      signal
    )
    manifestFiles = depFiles.length
    if (depFiles.length === 0) {
      recordCoverageIssue(coverageIssues, {
        scanner: "sca",
        status: "unsupported",
        reason: "No dependency manifests or lockfiles were found",
      })
      logger.info("No dependency files found", { repoPath })
      if (discovery) {
        discovery.sca = {
          filesScanned: 0,
          bytesScanned: 0,
          skippedByReason: { noManifests: 1 },
        }
      }
      return []
    }
    if (depFiles.some((file) => ["composer.json", "composer.lock"].includes(basename(file)))) {
      const inventory = await resolveExactDependencies({ repoPath, coverageIssues, signal })
      allDeps.push(...inventory.packages.filter((pkg) => pkg.ecosystem === "Packagist"))
      if (inventory.status !== "COMPLETE") emptyManifests++
    }
    for (const file of depFiles) {
      throwIfAborted(signal)
      try {
        const stat = await lstat(join(repoPath, file))
        manifestBytes += stat.size
      } catch {
        // manifest may have been removed between walk and parse
      }
      if (["composer.json", "composer.lock"].includes(basename(file))) continue
      const deps = await parseDependencyFile(file, repoPath, coverageIssues)
      if (deps.length === 0) {
        emptyManifests++
        recordCoverageIssue(coverageIssues, {
          scanner: "sca",
          status: "partial",
          subject: file,
          reason: "Dependency manifest has no readable resolved dependencies",
        })
      }
      allDeps.push(...deps)
    }
  }
  if (discovery) {
    discovery.sca = {
      filesScanned: manifestFiles,
      bytesScanned: manifestBytes,
      skippedByReason: { emptyOrTruncated: emptyManifests },
    }
  }

  return allDeps
}
