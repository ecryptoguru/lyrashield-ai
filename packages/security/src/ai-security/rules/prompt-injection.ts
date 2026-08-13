import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_01_RULE_ID = "AI-01.prompt-injection" as const

const LLM_CALL_PATTERNS = [
  /openai\.chat\.completions\.create\s*\(/i,
  /anthropic\.messages\.create\s*\(/i,
  /new\s+ChatOpenAI\s*\(/i,
  /new\s+ChatAnthropic\s*\(/i,
  /new\s+ChatGoogleGenerativeAI\s*\(/i,
  /\.invoke\s*\(\s*\{/i,
]

const USER_INPUT_PATTERNS = [
  /req\.body/i,
  /req\.query/i,
  /userInput\b/i,
  /userMessage\b/i,
  /req\.body\.message/i,
]

const GUARD_PATTERNS = [
  /checkInstructionSafety/i,
  /sanitizeInstructionInput/i,
  /rebuff/i,
  /guardrails/i,
  /prompt-injection-guard/i,
  /sanitizeInput/i,
  /validateInput/i,
  /filterInput/i,
]

export function detectPromptInjection(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-01", AI_01_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const hasLlmCall = LLM_CALL_PATTERNS.some((pattern) => pattern.test(file.content))
  if (!hasLlmCall) {
    return [noFindingSignal("AI-01", AI_01_RULE_ID, file)]
  }

  const hasUserInput = USER_INPUT_PATTERNS.some((pattern) => pattern.test(file.content))
  if (!hasUserInput) {
    return [noFindingSignal("AI-01", AI_01_RULE_ID, file)]
  }

  const hasGuard = GUARD_PATTERNS.some((pattern) => pattern.test(file.content))
  if (hasGuard) {
    return [noFindingSignal("AI-01", AI_01_RULE_ID, file)]
  }

  let firstMatch = -1
  for (const pattern of LLM_CALL_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(file.content)
    if (match && (firstMatch === -1 || match.index < firstMatch)) {
      firstMatch = match.index
    }
  }

  if (firstMatch === -1) {
    return [noFindingSignal("AI-01", AI_01_RULE_ID, file)]
  }

  const end = firstMatch + file.content.slice(firstMatch).indexOf("(") + 1
  return [detectedSignal("AI-01", AI_01_RULE_ID, file, { start: firstMatch, end })]
}
