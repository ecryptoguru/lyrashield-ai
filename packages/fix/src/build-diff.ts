/**
 * Deterministic unified-diff builder for the WP3 fix producer.
 *
 * The scan engine emits structured fixes (fix_before / fix_after) for a
 * finding's implicated file — not a git diff. This builds the unified diff from
 * the original file content and the fixed content with no model call, so the
 * patch is a faithful, reviewable transformation of what the engine proposed.
 *
 * Pure function: no I/O. The producer (worker job) fetches the original file
 * content, applies the before→after replacement, and calls this to render the
 * diff that the validator and the approval binding then consume.
 */

import { createHash } from "node:crypto"

function splitLines(text: string): string[] {
  return text.split("\n")
}

/**
 * Build a unified diff between two versions of a single file using a simple
 * LCS-based line diff. Suitable for the small, focused patches the engine
 * produces; not a general-purpose diff for large rewrites (the scope validator
 * caps patch size anyway).
 */
export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const a = splitLines(before)
  const b = splitLines(after)

  // Longest-common-subsequence over lines to find the changed region.
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const ops: Array<{ type: " " | "-" | "+"; line: string }> = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "-", line: a[i]! })
      i++
    } else {
      ops.push({ type: "+", line: b[j]! })
      j++
    }
  }
  while (i < m) {
    ops.push({ type: "-", line: a[i]! })
    i++
  }
  while (j < n) {
    ops.push({ type: "+", line: b[j]! })
    j++
  }

  // Find the changed span and add 3 lines of context each side (git default).
  const firstChange = ops.findIndex((op) => op.type !== " ")
  const lastChange = ops.length - 1 - [...ops].reverse().findIndex((op) => op.type !== " ")
  if (firstChange === -1) return "" // no change — empty diff

  const CONTEXT = 3
  const start = Math.max(0, firstChange - CONTEXT)
  const end = Math.min(ops.length, lastChange + CONTEXT + 1)
  const slice = ops.slice(start, end)

  // Compute hunk line counts for the header.
  let oldStart = 0
  let oldCursor = 0
  for (let k = 0; k < start; k++) if (ops[k]!.type !== "+") oldCursor++
  oldStart = oldCursor + 1
  const oldCount = slice.filter((op) => op.type !== "+").length
  const newCount = slice.filter((op) => op.type !== "-").length
  let newCursor = 0
  for (let k = 0; k < start; k++) if (ops[k]!.type !== "-") newCursor++
  const newStart = newCursor + 1

  const header = `diff --git a/${path} b/${path}`
  const ranges = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
  const body = slice.map((op) => `${op.type}${op.line}`).join("\n")

  return [header, `--- a/${path}`, `+++ b/${path}`, ranges, body].join("\n")
}

/** SHA-256 over the engine's proposed fix content (provenance). */
export function fixContentChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}
