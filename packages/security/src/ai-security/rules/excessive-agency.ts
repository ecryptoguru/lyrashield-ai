import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_05_RULE_ID = "AI-05.excessive-agency" as const

/**
 * Destructive verbs, matched on a word-character boundary.
 *
 * A bare substring test was used before (`lower.includes("rm")`), which also
 * matched `userMessage`, `perform`, `format`, `transform` and `terms` — so
 * ordinary code was reported as "unbounded agent permissions". The rule runs per
 * line rather than only over tool declarations, so the false-positive surface was
 * very wide.
 *
 * Lookarounds are used instead of `\b` because `\b` fails when a name is glued to
 * a separator: in `delete_file` the position after `delete` is followed by `_`,
 * which is itself a word character, so `delete\b` would not match and the genuine
 * case would be lost.
 */
const DESTRUCTIVE_NAME_PATTERN =
  /(?<![A-Za-z0-9])(?:delete|remove|drop|rm|truncate|overwrite|destroy)(?![A-Za-z0-9])/i

const AUTO_APPROVE_PATTERNS = [
  /autoApprove\s*:\s*true/i,
  /autoApprove\s*:\s*["\']true["\']/i,
  /requireApproval\s*:\s*false/i,
  /autoExecute\s*:\s*true/i,
  /autoExecute\s*:\s*["\']true["\']/i,
  /allow_mutations\s*:\s*true/i,
]

function hasDestructiveToolWithoutApproval(line: string): boolean {
  if (!DESTRUCTIVE_NAME_PATTERN.test(line)) return false

  const hasApproval = /requireApproval\s*:\s*true|require_approval\s*:\s*true/i.test(line)
  const hasAutoApprove = /autoApprove\s*:\s*true|auto_approve\s*:\s*true/i.test(line)

  return hasAutoApprove || !hasApproval
}

export function detectExcessiveAgency(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-05", AI_05_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const lines = file.content.split("\n")
  for (const [index, line] of lines.entries()) {
    if (hasDestructiveToolWithoutApproval(line)) {
      const start = lines.slice(0, index).join("\n").length + (index > 0 ? 1 : 0)
      return [detectedSignal("AI-05", AI_05_RULE_ID, file, { start, end: start + line.length })]
    }

    if (AUTO_APPROVE_PATTERNS.some((pattern) => pattern.test(line))) {
      const start = lines.slice(0, index).join("\n").length + (index > 0 ? 1 : 0)
      return [detectedSignal("AI-05", AI_05_RULE_ID, file, { start, end: start + line.length })]
    }
  }

  return [noFindingSignal("AI-05", AI_05_RULE_ID, file)]
}
