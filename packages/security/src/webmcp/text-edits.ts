import type { WebMcpTextEdit } from "./types"

export function sortedByPosition(edits: WebMcpTextEdit[]): WebMcpTextEdit[] {
  return [...edits].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine
    return a.startColumn - b.startColumn
  })
}

export function applyWebMcpRewrite(content: string, edits: WebMcpTextEdit[]): string {
  const sorted = sortedByPosition(edits).reverse()
  const lines = content.split("\n")
  for (const edit of sorted) {
    const startLineIndex = Math.max(0, edit.startLine - 1)
    const endLineIndex = Math.max(0, edit.endLine - 1)
    if (startLineIndex >= lines.length) continue
    const before = lines.slice(0, startLineIndex)
    const after = lines.slice(endLineIndex + 1)
    const startLine = lines[startLineIndex] ?? ""
    const endLine = lines[endLineIndex] ?? startLine
    const prefix = startLine.slice(0, edit.startColumn)
    const suffix = endLine.slice(edit.endColumn)
    before.push(`${prefix}${edit.newText}${suffix}`)
    lines.splice(0, lines.length, ...before, ...after)
  }
  return lines.join("\n")
}

export function generateWebMcpDiff(before: string, after: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const result: string[] = []
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i] ?? ""
    const a = afterLines[i] ?? ""
    if (b === a) {
      result.push(` ${b}`)
    } else {
      if (b) result.push(`-${b}`)
      if (a) result.push(`+${a}`)
    }
  }
  return result.join("\n")
}
