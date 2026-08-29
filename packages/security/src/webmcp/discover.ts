import { computeDefinitionHash, computeInventoryHash } from "./canonicalize"
import { discoverDeclarativeTools } from "./discover-declarative"
import { discoverImperativeTools } from "./discover-imperative"
import { sha256, sha256Sync } from "./hash"
import { WEBMCP_DETECTOR_VERSION } from "./types"
import type {
  WebMcpEvaluateContext,
  WebMcpScanFile,
  WebMcpScanLimit,
  WebMcpToolInventory,
  WebMcpToolSurface,
  WebMcpDiscoveryOptions,
  WebMcpEvidenceLocation,
} from "./types"

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".html",
  ".htm",
])

const CONFIG_FILE_NAMES = new Set([
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "vercel.json",
  "_headers",
  ".htaccess",
  "nginx.conf",
])

const DEFAULT_LIMITS = {
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxWallTimeMs: 60_000,
  maxDefinitions: 500,
  maxWalkEntries: 50_000,
  maxWalkDepth: 40,
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("WebMCP discovery cancelled")
}

function isAstroFile(file: WebMcpScanFile): boolean {
  return file.extension === ".astro"
}

function isSupportedFile(file: WebMcpScanFile): boolean {
  const basename = file.path.split("/").pop() ?? ""
  const isConfig = CONFIG_FILE_NAMES.has(basename)
  return (isConfig || SUPPORTED_EXTENSIONS.has(file.extension)) && file.truncated !== true
}

function getLineNumber(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

interface AstroRegion {
  kind: "frontmatter" | "script" | "template"
  content: string
  lineOffset: number
}

function extractAstroRegions(file: WebMcpScanFile): AstroRegion[] {
  const content = file.content
  const regions: AstroRegion[] = []
  const reserved: { start: number; end: number }[] = []

  // Frontmatter: first pair of --- delimiters at the start of a line.
  const delimiterRegex = /^---\s*$/gm
  const delimiters: { index: number; line: number }[] = []
  let m: RegExpExecArray | null
  while ((m = delimiterRegex.exec(content)) !== null) {
    delimiters.push({ index: m.index, line: getLineNumber(content, m.index) })
  }

  if (delimiters.length >= 2) {
    const open = delimiters[0]!
    const close = delimiters[1]!
    if (open.index === 0 || content.slice(0, open.index).trim() === "") {
      const start = open.index + 3
      const firstContentLine = open.line + 1
      regions.push({
        kind: "frontmatter",
        content: content.slice(start, close.index).replace(/^\n/, ""),
        lineOffset: firstContentLine - 1,
      })
      reserved.push({ start: open.index, end: close.index + 3 })
    }
  }

  // Scripts: <script ...>...</script> blocks.
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
  for (const match of content.matchAll(scriptRegex)) {
    const fullStart = match.index
    const fullEnd = match.index + match[0].length
    const tagEnd = content.indexOf(">", fullStart) + 1
    if (tagEnd <= 0) continue
    const contentStart = tagEnd
    const contentEnd = contentStart + (match[1]?.length ?? 0)
    const firstContentLine = getLineNumber(content, contentStart)
    regions.push({
      kind: "script",
      content: content.slice(contentStart, contentEnd),
      lineOffset: firstContentLine - 1,
    })
    reserved.push({ start: fullStart, end: fullEnd })
  }

  // Template: original content with frontmatter/script regions replaced by blank lines.
  reserved.sort((a, b) => a.start - b.start)
  const templateParts: string[] = []
  let current = 0
  for (const r of reserved) {
    templateParts.push(content.slice(current, r.start))
    const original = content.slice(r.start, r.end)
    const newlines = (original.match(/\n/g) ?? []).length
    templateParts.push("\n".repeat(newlines))
    current = r.end
  }
  templateParts.push(content.slice(current))

  regions.push({
    kind: "template",
    content: templateParts.join(""),
    lineOffset: 0,
  })

  return regions
}

type ExposureEvidenceKey = "originAgentClusterDisabled" | "unsafeToolsPolicy" | "documentDomain"

function evidenceLocation(
  file: WebMcpScanFile,
  start: number,
  end: number
): WebMcpEvidenceLocation {
  return {
    path: file.path,
    startLine: getLineNumber(file.content, start),
    endLine: getLineNumber(file.content, end),
    contentHash: sha256Sync(file.content),
  }
}

function recordExposureEvidence(
  context: WebMcpEvaluateContext,
  key: ExposureEvidenceKey,
  file: WebMcpScanFile,
  start: number,
  end: number
): void {
  context.headerExposure ??= {}
  context.headerExposure.evidence ??= {}
  const existing = context.headerExposure.evidence[key] ?? []
  existing.push(evidenceLocation(file, start, end))
  context.headerExposure.evidence[key] = existing
}

function toolsPolicyIsUnsafe(value: string): boolean {
  const match = /\btools\s*=\s*(\([^)]*\)|[^,;\s]+)/i.exec(value)
  if (!match) return false
  const tokens = match[1]!
    .replace(/[()"']/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  return tokens.length !== 1 || tokens[0]!.toLowerCase() !== "self"
}

const RAW_ORIGIN_AGENT_CLUSTER = /^\s*Origin-Agent-Cluster\s*:\s*([^\n\r]+)/gim
const RAW_PERMISSIONS_POLICY = /^\s*Permissions-Policy\s*:\s*([^\n\r]+)/gim
const OBJECT_ORIGIN_AGENT_CLUSTER =
  /key\s*:\s*["']Origin-Agent-Cluster["']([^{}]{0,500})value\s*:\s*["']([^"']+)["']/gi
const OBJECT_PERMISSIONS_POLICY =
  /key\s*:\s*["']Permissions-Policy["']([^{}]{0,500})value\s*:\s*["']([^"']+)["']/gi

function configValues(
  content: string,
  header: "Origin-Agent-Cluster" | "Permissions-Policy"
): Array<{ value: string; start: number; end: number }> {
  const values: Array<{ value: string; start: number; end: number }> = []
  const raw = header === "Origin-Agent-Cluster" ? RAW_ORIGIN_AGENT_CLUSTER : RAW_PERMISSIONS_POLICY
  raw.lastIndex = 0
  for (const match of content.matchAll(raw)) {
    values.push({ value: match[1]!.trim(), start: match.index, end: match.index + match[0].length })
  }

  const object =
    header === "Origin-Agent-Cluster" ? OBJECT_ORIGIN_AGENT_CLUSTER : OBJECT_PERMISSIONS_POLICY
  object.lastIndex = 0
  for (const match of content.matchAll(object)) {
    values.push({ value: match[2]!.trim(), start: match.index, end: match.index + match[0].length })
  }
  return values
}

function discoverConfigExposure(file: WebMcpScanFile, context: WebMcpEvaluateContext): void {
  if (!CONFIG_FILE_NAMES.has(file.path.split("/").pop() ?? "")) return
  const content = file.content
  const lower = content.toLowerCase()
  const originAgentCluster = configValues(content, "Origin-Agent-Cluster")
  if (originAgentCluster.length > 0) {
    context.headerExposure ??= {}
    context.headerExposure.hasOriginAgentCluster ??= true
    for (const entry of originAgentCluster) {
      if (/^\?0\b/.test(entry.value)) {
        context.headerExposure.hasOriginAgentCluster = false
        recordExposureEvidence(context, "originAgentClusterDisabled", file, entry.start, entry.end)
      }
    }
  }
  const permissionsPolicies = configValues(content, "Permissions-Policy")
  for (const entry of permissionsPolicies) {
    context.headerExposure ??= {}
    if (toolsPolicyIsUnsafe(entry.value)) {
      context.headerExposure.hasWildcardToolsPolicy = true
      recordExposureEvidence(context, "unsafeToolsPolicy", file, entry.start, entry.end)
    } else if (/\btools\s*=/i.test(entry.value)) {
      context.headerExposure.hasToolsSelfPolicy = true
    }
  }
  if (lower.includes("document.domain")) {
    context.headerExposure ??= {}
    context.headerExposure.hasDocumentDomain = true
    const start = lower.indexOf("document.domain")
    recordExposureEvidence(context, "documentDomain", file, start, start + "document.domain".length)
  }
}

export async function discoverWebMcpTools(
  files: WebMcpScanFile[],
  options: WebMcpDiscoveryOptions = {}
): Promise<{ inventory: WebMcpToolInventory; context: WebMcpEvaluateContext }> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const signal = options.signal
  const start = Date.now()
  const limitsReached: WebMcpScanLimit[] = []
  const unsupportedFiles: string[] = []
  const truncatedFiles: string[] = []
  const notes: string[] = []
  const context: WebMcpEvaluateContext = {}

  let totalBytes = 0
  const selected: WebMcpScanFile[] = []

  for (const file of files) {
    throwIfAborted(signal)
    if (!isSupportedFile(file)) {
      unsupportedFiles.push(file.path)
      continue
    }
    if (file.size > limits.maxFileBytes) {
      limitsReached.push("max_file_bytes")
      truncatedFiles.push(file.path)
      continue
    }
    if (selected.length >= limits.maxFiles) {
      limitsReached.push("max_files")
      truncatedFiles.push(file.path)
      continue
    }
    if (totalBytes + file.size > limits.maxTotalBytes) {
      limitsReached.push("max_total_bytes")
      truncatedFiles.push(file.path)
      continue
    }
    selected.push(file)
    totalBytes += file.size
  }

  if (Date.now() - start > limits.maxWallTimeMs) {
    limitsReached.push("max_wall_time_ms")
    notes.push("Discovery reached the wall-time limit before finishing.")
  }

  const definitions: WebMcpToolSurface[] = []
  let incompleteDefinitions = 0
  let definitionLimitReached = false

  const remainingDefinitions = () => Math.max(0, limits.maxDefinitions - definitions.length)

  for (const file of selected) {
    throwIfAborted(signal)
    if (Date.now() - start > limits.maxWallTimeMs) {
      limitsReached.push("max_wall_time_ms")
      notes.push("Discovery reached the wall-time limit while scanning files.")
      break
    }

    if (isAstroFile(file)) {
      const regions = extractAstroRegions(file)
      for (const region of regions) {
        throwIfAborted(signal)

        if (region.kind === "frontmatter" || region.kind === "script") {
          const result = await discoverImperativeTools(
            { ...file, content: region.content },
            region.lineOffset,
            signal,
            remainingDefinitions()
          )
          for (const tool of result.tools) {
            tool.source.path = file.path
            definitions.push(tool)
          }
          incompleteDefinitions += result.incomplete
          definitionLimitReached ||= result.limitReached
        } else {
          const result = await discoverDeclarativeTools(
            { ...file, content: region.content },
            region.lineOffset,
            signal,
            { ...limits, maxDefinitions: remainingDefinitions() }
          )
          for (const tool of result.tools) {
            tool.source.path = file.path
            definitions.push(tool)
          }
          if (result.hasToolIframe) {
            context.headerExposure ??= {}
            context.headerExposure!.hasDelegatedToolsIframe = true
            context.headerExposure.evidence ??= {}
            context.headerExposure.evidence.delegatedToolsIframe ??= []
            context.headerExposure.evidence.delegatedToolsIframe.push(
              evidenceLocation(file, 0, file.content.length)
            )
          }
          incompleteDefinitions += result.incomplete
          limitsReached.push(...result.limitsReached)
          definitionLimitReached ||= result.limitsReached.includes("max_definitions")
        }
        if (definitionLimitReached) break
      }
    } else if (file.extension === ".html" || file.extension === ".htm") {
      for (const region of extractAstroRegions(file)) {
        throwIfAborted(signal)
        if (region.kind === "script") {
          const result = await discoverImperativeTools(
            { ...file, content: region.content },
            region.lineOffset,
            signal,
            remainingDefinitions()
          )
          definitions.push(...result.tools)
          incompleteDefinitions += result.incomplete
          definitionLimitReached ||= result.limitReached
        } else if (region.kind === "template") {
          const result = await discoverDeclarativeTools(
            { ...file, content: region.content },
            0,
            signal,
            { ...limits, maxDefinitions: remainingDefinitions() }
          )
          definitions.push(...result.tools)
          if (result.hasToolIframe) {
            context.headerExposure ??= {}
            context.headerExposure!.hasDelegatedToolsIframe = true
            context.headerExposure.evidence ??= {}
            context.headerExposure.evidence.delegatedToolsIframe ??= []
            context.headerExposure.evidence.delegatedToolsIframe.push(
              evidenceLocation(file, 0, file.content.length)
            )
          }
          incompleteDefinitions += result.incomplete
          limitsReached.push(...result.limitsReached)
          definitionLimitReached ||= result.limitsReached.includes("max_definitions")
        }
        if (definitionLimitReached) break
      }
    } else if (
      file.extension === ".js" ||
      file.extension === ".jsx" ||
      file.extension === ".ts" ||
      file.extension === ".tsx" ||
      file.extension === ".mjs" ||
      file.extension === ".cjs"
    ) {
      const result = await discoverImperativeTools(file, 0, signal, remainingDefinitions())
      for (const tool of result.tools) {
        tool.source.path = file.path
        definitions.push(tool)
      }
      incompleteDefinitions += result.incomplete
      definitionLimitReached ||= result.limitReached
    }

    discoverConfigExposure(file, context)

    if (definitionLimitReached) {
      limitsReached.push("max_definitions")
      notes.push(`Discovery stopped after ${limits.maxDefinitions} tool definitions.`)
      break
    }
  }

  for (const tool of definitions) {
    tool.definitionHash = await computeDefinitionHash(tool, sha256)
  }

  const checksum = await computeInventoryHash(
    definitions,
    sha256,
    context,
    selected.map((file) => ({ path: file.path, contentHash: sha256Sync(file.content) }))
  )

  const inventory: WebMcpToolInventory = {
    version: "webmcp-inventory/1",
    detectorVersion: WEBMCP_DETECTOR_VERSION,
    definitions,
    checksum,
    incompleteDefinitions,
    limitsReached: [...new Set(limitsReached)],
    unsupportedFiles,
    truncatedFiles,
    notes,
  }

  return { inventory, context }
}
