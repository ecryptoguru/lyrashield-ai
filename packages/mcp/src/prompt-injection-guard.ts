import { logger } from "@lyrashield/logger"

export interface GuardResult {
  allowed: boolean
  reason?: string
  sanitizedInput?: string
  detectedPatterns: string[]
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+(instructions|prompts)/gi, name: "instruction_override" },
  { pattern: /disregard\s+(all\s+)?prior/gi, name: "instruction_override" },
  { pattern: /forget\s+(everything|all\s+previous)/gi, name: "memory_wipe" },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/gi, name: "role_hijack" },
  { pattern: /act\s+as\s+(if\s+you\s+are|a|an)\s+/gi, name: "role_hijack" },
  { pattern: /new\s+instructions?\s*:/gi, name: "instruction_injection" },
  { pattern: /system\s*:\s*/gi, name: "system_prefix" },
  { pattern: /\<\/?system\>/gi, name: "system_tag" },
  { pattern: /\<\/?prompt\>/gi, name: "prompt_tag" },
  { pattern: /reveal\s+(your|the)\s+(system\s+)?prompt/gi, name: "prompt_extraction" },
  { pattern: /show\s+me\s+your\s+(instructions|rules|guidelines)/gi, name: "prompt_extraction" },
  { pattern: /execute\s+(arbitrary\s+)?code/gi, name: "code_execution" },
  { pattern: /eval\s*\(/gi, name: "code_execution" },
  { pattern: /require\s*\(/gi, name: "code_execution" },
  { pattern: /import\s*\(/gi, name: "code_execution" },
  { pattern: /child_process/gi, name: "code_execution" },
  { pattern: /process\.env/gi, name: "env_extraction" },
  { pattern: /file:\/\/\//gi, name: "file_access" },
  { pattern: /\/etc\/passwd/gi, name: "file_access" },
  { pattern: /rm\s+-rf/gi, name: "destructive_command" },
  { pattern: /DROP\s+TABLE/gi, name: "sql_injection" },
  { pattern: /;\s*DELETE\s+FROM/gi, name: "sql_injection" },
  { pattern: /;\s*UPDATE\s+.*\s+SET/gi, name: "sql_injection" },
  { pattern: /\bUNION\s+SELECT\b/gi, name: "sql_injection" },
  { pattern: /javascript:/gi, name: "xss_vector" },
  { pattern: /onerror\s*=/gi, name: "xss_vector" },
  { pattern: /onload\s*=/gi, name: "xss_vector" },
  { pattern: /<script/gi, name: "xss_vector" },
]

const CONTEXT_BOUNDARY_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\n\s*---\s*\n/g, name: "markdown_separator" },
  { pattern: /\n\s*\*\*\*\s*\n/g, name: "markdown_separator" },
  { pattern: /\[INST\]/gi, name: "instruction_tag" },
  { pattern: /\[\/INST\]/gi, name: "instruction_tag" },
  { pattern: /<\|im_start\|>/gi, name: "chatml_tag" },
  { pattern: /<\|im_end\|>/gi, name: "chatml_tag" },
]

export class PromptInjectionGuard {
  private maxInputLength: number
  private strictMode: boolean

  constructor(options?: { maxInputLength?: number; strictMode?: boolean }) {
    this.maxInputLength = options?.maxInputLength ?? 10000
    this.strictMode = options?.strictMode ?? true
  }

  check(input: string): GuardResult {
    const detectedPatterns: string[] = []

    if (input.length > this.maxInputLength) {
      return {
        allowed: false,
        reason: `Input exceeds maximum length of ${this.maxInputLength} characters`,
        detectedPatterns: ["input_too_long"],
      }
    }

    for (const { pattern, name } of INJECTION_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(input)) {
        detectedPatterns.push(name)
      }
    }

    for (const { pattern, name } of CONTEXT_BOUNDARY_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(input)) {
        detectedPatterns.push(name)
      }
    }

    const criticalPatterns = detectedPatterns.filter(
      (p) =>
        p === "instruction_override" ||
        p === "role_hijack" ||
        p === "code_execution" ||
        p === "sql_injection" ||
        p === "destructive_command" ||
        p === "env_extraction" ||
        p === "prompt_extraction",
    )

    if (criticalPatterns.length > 0) {
      logger.warn("Prompt injection detected", {
        patterns: criticalPatterns,
        inputLength: input.length,
      })
      return {
        allowed: false,
        reason: `Potential prompt injection detected: ${criticalPatterns.join(", ")}`,
        detectedPatterns,
      }
    }

    if (detectedPatterns.length > 0 && this.strictMode) {
      const sanitized = this.sanitize(input)
      return {
        allowed: true,
        reason: `Suspicious patterns detected but not blocking: ${detectedPatterns.join(", ")}`,
        sanitizedInput: sanitized,
        detectedPatterns,
      }
    }

    return {
      allowed: true,
      detectedPatterns,
    }
  }

  private sanitize(input: string): string {
    let sanitized = input
    for (const { pattern } of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]")
    }
    for (const { pattern } of CONTEXT_BOUNDARY_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]")
    }
    return sanitized
  }

  checkToolCall(toolName: string, args: Record<string, unknown>): GuardResult {
    const serialized = JSON.stringify({ tool: toolName, args })
    const result = this.check(serialized)

    if (result.allowed && result.sanitizedInput) {
      try {
        const parsed = JSON.parse(result.sanitizedInput)
        result.sanitizedInput = JSON.stringify({ tool: toolName, args: parsed.args ?? args })
      } catch {
        result.sanitizedInput = JSON.stringify({ tool: toolName, args })
      }
    }

    return result
  }
}
