import {
  detectedSignal,
  extractCallBlock,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_08_RULE_ID = "AI-08.consumption-limits" as const

const LLM_CALL_PATTERNS = [
  /chat\.completions\.create\s*\(/i,
  /\.chat\.completions\.create\s*\(/i,
  /\.invoke\s*\(/i,
  /\.call\s*\(/i,
]

const LOOP_PATTERNS = [
  /while\s*\(\s*true\s*\)/i,
  /while\s*\(\s*!done\s*\)/i,
  /while\s*\(\s*[^)]+\s*\)/i,
]

function hasMaxTokens(callText: string): boolean {
  return /max_tokens\s*:/i.test(callText) || /maxTokens\s*:/i.test(callText)
}

function hasTimeout(callText: string): boolean {
  return /timeout\s*:/i.test(callText)
}

function hasLoopWithLlmCall(content: string): boolean {
  if (!LOOP_PATTERNS.some((pattern) => pattern.test(content))) return false

  const lower = content.toLowerCase()
  return LLM_CALL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(lower)
  })
}

export function detectConsumptionLimits(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-08", AI_08_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const hasLoop = hasLoopWithLlmCall(file.content)
  const loopLineIndex = hasLoop
    ? file.content
        .split("\n")
        .findIndex((line) => LOOP_PATTERNS.some((pattern) => pattern.test(line)))
    : -1

  const lines = file.content.split("\n")
  for (const [index, line] of lines.entries()) {
    const hasCall = LLM_CALL_PATTERNS.some((pattern) => pattern.test(line))
    if (!hasCall) continue

    const prior = lines.slice(0, index).join("\n")
    const start = prior.length + (index > 0 ? 1 : 0)
    const callBlock = extractCallBlock(file.content, start)

    const missingMaxTokens = !hasMaxTokens(callBlock)
    const missingTimeout = !hasTimeout(callBlock)

    if (missingMaxTokens || missingTimeout) {
      const end = start + line.length
      return [detectedSignal("AI-08", AI_08_RULE_ID, file, { start, end })]
    }
  }

  if (hasLoop && loopLineIndex !== -1) {
    const start = lines.slice(0, loopLineIndex).join("\n").length + (loopLineIndex > 0 ? 1 : 0)
    const line = lines[loopLineIndex]
    if (line) {
      return [detectedSignal("AI-08", AI_08_RULE_ID, file, { start, end: start + line.length })]
    }
  }

  return [noFindingSignal("AI-08", AI_08_RULE_ID, file)]
}
