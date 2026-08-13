import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_05_RULE_ID = "AI-05.excessive-agency" as const

const DESTRUCTIVE_NAMES = ["delete", "remove", "drop", "rm", "truncate", "overwrite", "destroy"]

const AUTO_APPROVE_PATTERNS = [
  /autoApprove\s*:\s*true/i,
  /autoApprove\s*:\s*["\']true["\']/i,
  /requireApproval\s*:\s*false/i,
  /autoExecute\s*:\s*true/i,
  /autoExecute\s*:\s*["\']true["\']/i,
  /allow_mutations\s*:\s*true/i,
]

function hasDestructiveToolWithoutApproval(line: string): boolean {
  const lower = line.toLowerCase()
  const isDestructive = DESTRUCTIVE_NAMES.some((name) => lower.includes(name))
  if (!isDestructive) return false

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
