import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_06_RULE_ID = "AI-06.system-prompt" as const

const CLIENT_EXTENSIONS = new Set([".jsx", ".tsx", ".vue", ".svelte", ".html", ".astro"])

const PUBLIC_ENV_PATTERNS = [/NEXT_PUBLIC_/i, /VITE_/i, /PUBLIC_/i]

const SYSTEM_PROMPT_PATTERNS = [
  /role\s*:\s*["\']\s*system\s*["\']/i,
  /const\s+SYSTEM_PROMPT\s*=/i,
  /const\s+systemPrompt\s*=/i,
  /system\s+prompt/i,
  /You are an AI assistant/i,
  /Do not reveal this prompt/i,
]

export function detectSystemPrompt(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-06", AI_06_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const isClientFile = CLIENT_EXTENSIONS.has(file.extension)

  const lines = file.content.split("\n")
  for (const [index, line] of lines.entries()) {
    const hasPublicEnv = PUBLIC_ENV_PATTERNS.some((pattern) => pattern.test(line))
    const hasSystemPrompt = SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(line))

    if (hasSystemPrompt && (isClientFile || hasPublicEnv)) {
      const start = lines.slice(0, index).join("\n").length + (index > 0 ? 1 : 0)
      return [detectedSignal("AI-06", AI_06_RULE_ID, file, { start, end: start + line.length })]
    }
  }

  return [noFindingSignal("AI-06", AI_06_RULE_ID, file)]
}
