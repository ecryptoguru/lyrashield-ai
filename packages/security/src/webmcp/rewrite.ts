import ts from "typescript"
import type {
  WebMcpControlId,
  WebMcpScanFile,
  WebMcpSignal,
  WebMcpTextEdit,
  WebMcpToolInventory,
  WebMcpRewritePlan,
} from "./types"
import { discoverWebMcpTools } from "./discover"
import { evaluateWebMcpSurface } from "./evaluate"
import { applyWebMcpRewrite } from "./text-edits"
import { computeEvidenceChecksum } from "./utils"

export { applyWebMcpRewrite, generateWebMcpDiff } from "./text-edits"

export interface WebMcpRewriteOptions {
  maxEditSizeBytes?: number
  maxEdits?: number
}

function compareEdits(a: WebMcpTextEdit, b: WebMcpTextEdit): number {
  const pathOrder = (a.path ?? "").localeCompare(b.path ?? "")
  if (pathOrder !== 0) return pathOrder
  if (a.startLine !== b.startLine) return a.startLine - b.startLine
  return a.startColumn - b.startColumn
}

function overlaps(a: WebMcpTextEdit, b: WebMcpTextEdit): boolean {
  if (a.path !== b.path) return false
  return a.endLine > b.startLine || (a.endLine === b.startLine && a.endColumn > b.startColumn)
}

function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer
    }
  }
  return undefined
}

function isRegisterToolCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== "registerTool") return false
  const object = node.expression.expression
  if (ts.isIdentifier(object)) return object.text === "modelContext"
  if (!ts.isPropertyAccessExpression(object) || object.name.text !== "modelContext") return false
  const root = object.expression
  return ts.isIdentifier(root) && (root.text === "document" || root.text === "navigator")
}

function isExactWildcard(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text === "*"
  }
  const only = ts.isArrayLiteralExpression(node) ? node.elements[0] : undefined
  return (
    ts.isArrayLiteralExpression(node) &&
    node.elements.length === 1 &&
    !!only &&
    (ts.isStringLiteral(only) || ts.isNoSubstitutionTemplateLiteral(only)) &&
    only.text === "*"
  )
}

interface ScriptRegion {
  content: string
  startOffset: number
}

function scriptRegions(file: WebMcpScanFile): ScriptRegion[] {
  if (/\.[cm]?[jt]sx?$/.test(file.extension)) {
    return [{ content: file.content, startOffset: 0 }]
  }
  if (file.extension !== ".html" && file.extension !== ".htm" && file.extension !== ".astro") {
    return []
  }

  const regions: ScriptRegion[] = []
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
  for (const match of file.content.matchAll(scriptPattern)) {
    const tagEnd = file.content.indexOf(">", match.index) + 1
    if (tagEnd <= 0) continue
    regions.push({
      content: match[1] ?? "",
      startOffset: tagEnd,
    })
  }
  return regions
}

function sourcePosition(content: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index++) {
    if (content[index] === "\n") {
      line++
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart }
}

function exposureEdit(file: WebMcpScanFile, signal: WebMcpSignal): WebMcpTextEdit | null {
  if (!signal.line) return null

  const scriptKind = file.extension.includes("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const candidates: { startOffset: number; endOffset: number }[] = []

  for (const region of scriptRegions(file)) {
    const sourceFile = ts.createSourceFile(
      file.path,
      region.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    )

    function visit(node: ts.Node): void {
      if (isRegisterToolCall(node)) {
        const absoluteCallStart = region.startOffset + node.getStart(sourceFile)
        if (sourcePosition(file.content, absoluteCallStart).line === signal.line) {
          const tool = node.arguments[0]
          const options = node.arguments[1]
          const exposure =
            options && ts.isObjectLiteralExpression(options)
              ? propertyValue(options, "exposedTo")
              : tool && ts.isObjectLiteralExpression(tool)
                ? propertyValue(tool, "exposedTo")
                : undefined
          if (exposure && isExactWildcard(exposure)) {
            candidates.push({
              startOffset: region.startOffset + exposure.getStart(sourceFile),
              endOffset: region.startOffset + exposure.getEnd(),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  if (candidates.length !== 1) return null
  const candidate = candidates[0]!
  const start = sourcePosition(file.content, candidate.startOffset)
  const end = sourcePosition(file.content, candidate.endOffset)
  return {
    path: file.path,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    newText: "[]",
    controlIds: ["WEBMCP-03"],
  }
}

function findSignalFile(files: WebMcpScanFile[], signal: WebMcpSignal): WebMcpScanFile | undefined {
  return signal.file ? files.find((file) => file.path === signal.file) : undefined
}

export async function planWebMcpRewrite(
  files: WebMcpScanFile[],
  signals: WebMcpSignal[],
  inventory: WebMcpToolInventory,
  options?: WebMcpRewriteOptions
): Promise<WebMcpRewritePlan> {
  const edits: WebMcpTextEdit[] = []
  const unresolved = new Set<WebMcpControlId>()
  const warnings: string[] = []
  const maxEditSize = options?.maxEditSizeBytes ?? 1024
  const maxEdits = options?.maxEdits ?? 100
  const inconclusive = signals.filter((signal) => signal.state === "INCONCLUSIVE")
  const detected = signals.filter((signal) => signal.state === "DETECTED")
  for (const signal of inconclusive) unresolved.add(signal.controlId)

  const current = await discoverWebMcpTools(files)
  const hasStaleEvidence = detected.some((signal) => {
    const file = findSignalFile(files, signal)
    return (
      !file ||
      computeEvidenceChecksum(
        file,
        signal.state,
        signal.controlId,
        signal.ruleId,
        signal.line,
        signal.endLine
      ) !== signal.evidenceChecksum
    )
  })
  if (
    inventory.incompleteDefinitions > 0 ||
    inventory.limitsReached.length > 0 ||
    current.inventory.checksum !== inventory.checksum ||
    hasStaleEvidence
  ) {
    for (const signal of detected) unresolved.add(signal.controlId)
    warnings.push(
      current.inventory.checksum !== inventory.checksum || hasStaleEvidence
        ? "Source inventory changed after analysis; rerun the checker before preparing a rewrite."
        : "Source analysis was incomplete; no rewrite was prepared."
    )
    return { edits, addressed: [], unresolved: [...unresolved], warnings }
  }

  const sortedSignals = [...detected].sort((a, b) => {
    if (a.file !== b.file) return (a.file ?? "").localeCompare(b.file ?? "")
    return (a.line ?? 0) - (b.line ?? 0)
  })
  const targetLocations = new Set<string>()

  for (const signal of sortedSignals) {
    if (signal.controlId !== "WEBMCP-03") {
      unresolved.add(signal.controlId)
      continue
    }
    if (edits.length >= maxEdits) {
      unresolved.add(signal.controlId)
      warnings.push(`Rewrite stopped at the ${maxEdits}-edit limit.`)
      continue
    }
    const file = findSignalFile(files, signal)
    const edit = file ? exposureEdit(file, signal) : null
    if (!file || !edit) {
      unresolved.add(signal.controlId)
      warnings.push(
        `No unambiguous exact-wildcard rewrite for ${signal.ruleId} at ${signal.file ?? "unknown"}:${signal.line ?? 0}.`
      )
      continue
    }
    if (new TextEncoder().encode(edit.newText).length > maxEditSize) {
      unresolved.add(signal.controlId)
      warnings.push(`Proposed edit for ${signal.ruleId} exceeds the size limit.`)
      continue
    }
    edits.push(edit)
    targetLocations.add(`${signal.file}:${signal.line}`)
  }

  const safe: WebMcpTextEdit[] = []
  for (const edit of edits.sort(compareEdits)) {
    const previous = safe[safe.length - 1]
    if (previous && overlaps(previous, edit)) {
      unresolved.add(edit.controlIds[0]!)
      warnings.push(`Overlapping edit for ${edit.controlIds.join(", ")} was dropped.`)
    } else {
      safe.push(edit)
    }
  }

  if (safe.length === 0) {
    return { edits: [], addressed: [], unresolved: [...unresolved], warnings }
  }

  const updatedFiles = files.map((file) => {
    const fileEdits = safe.filter((edit) => edit.path === file.path)
    return fileEdits.length === 0
      ? file
      : { ...file, content: applyWebMcpRewrite(file.content, fileEdits) }
  })
  const rerun = await discoverWebMcpTools(updatedFiles)
  const rerunSignals = evaluateWebMcpSurface(updatedFiles, rerun.inventory, rerun.context)
  const incomplete =
    rerun.inventory.incompleteDefinitions > 0 || rerun.inventory.limitsReached.length > 0
  const uncleared = rerunSignals.some(
    (signal) =>
      signal.controlId === "WEBMCP-03" &&
      signal.state !== "NO_FINDING" &&
      targetLocations.has(`${signal.file}:${signal.line}`)
  )

  if (incomplete || uncleared) {
    for (const edit of safe) unresolved.add(edit.controlIds[0]!)
    warnings.push(
      incomplete
        ? "Rewritten source could not be evaluated completely; no patch was returned."
        : "Generated rewrite did not clear WEBMCP-03; no patch was returned."
    )
    return { edits: [], addressed: [], unresolved: [...unresolved], warnings }
  }

  return {
    edits: safe,
    addressed: ["WEBMCP-03"],
    unresolved: [...unresolved],
    warnings,
    updatedChecksum: rerun.inventory.checksum,
  }
}
