import type { Dependency } from "./dependency-manifests"
import { recordCoverageIssue, type ScannerCoverageIssue } from "../scanner-coverage"

const MAX_POM_DEPENDENCY_BLOCKS = 5_000

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

export function parsePomXml(
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
