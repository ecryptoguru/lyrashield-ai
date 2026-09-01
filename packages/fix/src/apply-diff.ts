/**
 * Unified-diff applier for the WP3 fix-PR pipeline.
 *
 * Applies a validated unified diff to existing file content and returns the
 * new content. Fail-closed: any hunk that does not apply cleanly at its
 * expected position throws, so a patch never half-applies (founder requirement
 * T5 — failure must be safe and legible, never silent).
 *
 * This is a pure function: no I/O. The caller (the execution orchestrator)
 * fetches the current file content, calls this, and writes the result.
 */

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Raw diff lines within the hunk: context (' '), removal ('-'), addition ('+'). */
  lines: string[]
}

function parseHunks(diffForFile: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const raw of diffForFile) {
    if (raw.startsWith("@@")) {
      // Hunk header: "@@ -oldStart[,oldCount] +newStart[,newCount] @@".
      // Parsed by splitting the marker spans (no nested-quantifier regex, which
      // trips the unsafe-regex lint and adds ReDoS surface).
      const body = raw
        .slice(2, raw.indexOf("@@", 2) === -1 ? raw.length : raw.indexOf("@@", 2))
        .trim()
      const minusIdx = body.indexOf("-")
      const plusIdx = body.indexOf("+")
      if (minusIdx !== -1 && plusIdx !== -1) {
        const oldSpan = body
          .slice(minusIdx + 1, plusIdx)
          .trim()
          .split(",")
        const newSpan = body
          .slice(plusIdx + 1)
          .trim()
          .split(",")
        if (current) hunks.push(current)
        current = {
          oldStart: parseInt(oldSpan[0]!, 10),
          oldCount: oldSpan[1] ? parseInt(oldSpan[1], 10) : 1,
          newStart: parseInt(newSpan[0]!, 10),
          newCount: newSpan[1] ? parseInt(newSpan[1], 10) : 1,
          lines: [],
        }
        continue
      }
      if (current) current.lines.push(raw)
      continue
    }
    if (current) current.lines.push(raw)
  }
  if (current) hunks.push(current)
  return hunks
}

/** Extract the per-file diff sections for one path from a full diff. */
export function extractFileDiff(diff: string, path: string): string[] {
  const lines = diff.split("\n")
  const out: string[] = []
  let inFile = false
  const bPath = `b/${path}`
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith("diff --git ")) {
      inFile = l.includes(bPath) || l.includes(`a/${path}`)
      continue
    }
    if (
      inFile &&
      (l.startsWith("@@") ||
        l.startsWith(" ") ||
        l.startsWith("+") ||
        l.startsWith("-") ||
        l.startsWith("\\"))
    ) {
      // Stop at the metadata lines between header and first hunk.
      if (l.startsWith("---") || l.startsWith("+++")) continue
      out.push(l)
    }
  }
  return out
}

/**
 * Apply a unified diff to existing content. Returns the new content.
 * Throws if the diff does not apply cleanly.
 */
export function applyUnifiedDiff(original: string, fileDiffLines: string[]): string {
  const originalLines = original.split("\n")
  const hunks = parseHunks(fileDiffLines)
  if (hunks.length === 0) throw new Error("no hunks to apply")

  const result: string[] = []
  let cursor = 0 // index into originalLines (0-based)

  for (const hunk of hunks) {
    const targetIndex = hunk.oldStart - 1
    if (targetIndex < cursor) {
      throw new Error(`overlapping or out-of-order hunk at line ${hunk.oldStart}`)
    }
    // Copy unchanged lines up to this hunk.
    while (cursor < targetIndex) {
      result.push(originalLines[cursor]!)
      cursor++
    }
    // Apply the hunk.
    for (const raw of hunk.lines) {
      if (raw.startsWith(" ")) {
        const expected = raw.slice(1)
        if (originalLines[cursor] !== expected) {
          throw new Error(`context mismatch at line ${cursor + 1}`)
        }
        result.push(originalLines[cursor]!)
        cursor++
      } else if (raw.startsWith("-")) {
        const expected = raw.slice(1)
        if (originalLines[cursor] !== expected) {
          throw new Error(`removed-line mismatch at line ${cursor + 1}`)
        }
        cursor++ // drop the line
      } else if (raw.startsWith("+")) {
        result.push(raw.slice(1))
      } else if (raw.startsWith("\\")) {
        // "\ No newline at end of file" — ignore.
        continue
      }
    }
  }
  // Copy the remaining unchanged tail.
  while (cursor < originalLines.length) {
    result.push(originalLines[cursor]!)
    cursor++
  }
  return result.join("\n")
}
