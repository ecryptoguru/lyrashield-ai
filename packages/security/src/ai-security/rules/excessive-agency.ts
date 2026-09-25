import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_05_RULE_ID = "AI-05.excessive-agency" as const

/**
 * Destructive verbs. Matched on a word character boundary rather than with a
 * bare substring test: `includes("rm")` also matches `userMessage`, `perform`,
 * `format`, `transform` and even `terms`, so ordinary code was reported as
 * "unbounded agent permissions". `snake_case` and `confirm`-style names were
 * equally affected, and the rule fires on ANY line containing the token, not
 * just a tool declaration, so the false positive rate was very high.
 *
 * Edges are asserted in code rather than with `\b` because `\b` fails when the
 * name is glued to a separator: in `delete_file` the boundary after `delete` is
 * followed by `_`, which is itself a word character, so `delete\b` does not
 * match and the genuine `delete_file` case would be lost.
 */
const DESTRUCTIVE_NAMES = ["delete", "remove", "drop", "rm", "truncate", "overwrite", "destroy"]

const DESTRUCTIVE_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(?:${DESTRUCTIVE_NAMES.join("|")})(?![A-Za-z0-9])`,
  "i"
)

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
