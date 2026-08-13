import {
  detectedSignal,
  inconclusiveSignal,
  isUnsupportedOrTruncated,
  noFindingSignal,
} from "../utils"
import type { AIScanFile, AISecuritySignal } from "../types"

export const AI_02_RULE_ID = "AI-02.sensitive-context" as const

const SENSITIVE_ENV_PATTERNS = [
  /process\.env\.[A-Z_]*(?:SECRET|KEY|TOKEN|PRIVATE|PASSWORD|DATABASE_URL|AWS_|AZURE_|GCP_)/i,
]

const LLM_CONTEXT_PATTERNS = [
  /messages\s*:\s*\[/i,
  /content\s*:/i,
  /prompt\s*:/i,
  /console\.log\s*\(\s*["']?Prompt/i,
  /console\.log\s*\(\s*["']?LLM/i,
]

export function detectSensitiveContext(file: AIScanFile): AISecuritySignal[] {
  if (isUnsupportedOrTruncated(file)) {
    return [
      inconclusiveSignal("AI-02", AI_02_RULE_ID, file, "Unsupported language or truncated file"),
    ]
  }

  const hasLlmContext = LLM_CONTEXT_PATTERNS.some((pattern) => pattern.test(file.content))
  if (!hasLlmContext) {
    return [noFindingSignal("AI-02", AI_02_RULE_ID, file)]
  }

  const lines = file.content.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue

    const hasSensitiveEnv = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(line))
    const hasContext = LLM_CONTEXT_PATTERNS.some((pattern) => pattern.test(line))

    if (hasSensitiveEnv && hasContext) {
      const start = file.content.split("\n").slice(0, index).join("\n").length + (index > 0 ? 1 : 0)
      const end = start + line.length
      return [detectedSignal("AI-02", AI_02_RULE_ID, file, { start, end })]
    }
  }

  return [noFindingSignal("AI-02", AI_02_RULE_ID, file)]
}
