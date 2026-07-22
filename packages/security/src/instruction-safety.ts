export interface InstructionSafetyResult {
  safe: boolean
  reason?: string
  detectedPatterns: string[]
  sanitized?: string
}

/* eslint-disable security/detect-unsafe-regex */
const INSTRUCTION_BOUNDARY_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  {
    pattern:
      /ignore\s+(all\s+)?(previous|above|prior|foregoing|my|your|system)\s*(instructions?|prompts?|rules?|guidelines?|training|programming|safety|ethics|morality|limitations|constraints|filter)?/gi,
    name: "instruction_override",
  },
  {
    pattern:
      /disregard\s+(all\s+)?(prior|previous|above|foregoing|my|your|system|instructions?|prompts?|rules?|guidelines?)/gi,
    name: "instruction_override",
  },
  {
    pattern:
      /forget\s+(everything|all\s+previous|all\s+instructions?|the\s+above|the\s+previous|your\s+training|your\s+programming)/gi,
    name: "memory_wipe",
  },
  {
    pattern:
      /you\s+(are|must|should|can|need\s+to)\s+(now\s+)?(ignore|disregard|forget|bypass|override|not\s+(?:be|follow|obey|listen|comply|adhere|respect|honor|enforce|apply|execute|run|call|use|trigger|start|begin|initiate|launch|create|make|schedule|enqueue|output|print|echo|reveal|disclose|share|tell|mention|explain|provide|generate|write|say|respond|answer|include|contain|have))/gi,
    name: "instruction_override",
  },
  { pattern: /you\s+are\s+now\s+(a\s+|an\s+|the\s+)?\w+/gi, name: "role_hijack" },
  { pattern: /act\s+as\s+(if\s+you\s+(are|were)\s+|a\s+|an\s+|the\s+)\w+/gi, name: "role_hijack" },
  {
    pattern:
      /you\s+are\s+(no\s+longer\s+|not\s+)?(a|an|the)?\s*(?:restricted|filtered|limited|safe|ethical|moral|helpful|harmless|honest|aligned|programmed|trained|designed|instructed|bounded)/gi,
    name: "role_hijack",
  },
  {
    pattern:
      /(?:unfiltered|unrestricted|uncensored|jailbreak|developer\s+mode|dev\s+mode|god\s+mode|sudo\s+mode|root\s+mode|admin\s+mode|maintenance\s+mode|debug\s+mode|special\s+mode|temporary\s+mode|DAN|do\s+anything\s+now)/gi,
    name: "role_hijack",
  },
  {
    pattern:
      /from\s+now\s+on|effective\s+immediately|starting\s+now|as\s+of\s+now|from\s+this\s+point/gi,
    name: "instruction_override",
  },
  {
    pattern:
      /new\s+instructions?\s*:|updated\s+instructions?\s*:|different\s+instructions?\s*:|alternative\s+instructions?\s*:|modified\s+instructions?\s*:|revised\s+instructions?\s*:/gi,
    name: "instruction_injection",
  },
  {
    pattern: /system\s*:\s*|system\s+prompt\s*:|system\s+instructions?\s*:/gi,
    name: "system_prefix",
  },
  { pattern: /\<\/?system\>/gi, name: "system_tag" },
  { pattern: /\<\/?prompt\>/gi, name: "prompt_tag" },
  { pattern: /reveal\s+(?:your|the|this)\s+(?:system\s+)?prompt/gi, name: "prompt_extraction" },
  {
    pattern: /show\s+me\s+(?:your|the|this)\s+(instructions|rules|guidelines|system\s+prompt)/gi,
    name: "prompt_extraction",
  },
]

const CONTEXT_BOUNDARY_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /(?:^|\s)---(?:\s|$)/g, name: "markdown_separator" },
  { pattern: /(?:^|\s)\*\*\*(?:\s|$)/g, name: "markdown_separator" },
  { pattern: /\[INST\]/gi, name: "instruction_tag" },
  { pattern: /\[\/INST\]/gi, name: "instruction_tag" },
  { pattern: /<\|im_start\|>/gi, name: "chatml_tag" },
  { pattern: /<\|im_end\|>/gi, name: "chatml_tag" },
  { pattern: /(?:^|\s)###(?:\s|$)/g, name: "markdown_separator" },
  { pattern: /(?:^|\s)===(?:\s|$)/g, name: "markdown_separator" },
  { pattern: /\bUSER\s*:/gi, name: "role_prefix" },
  { pattern: /\bASSISTANT\s*:/gi, name: "role_prefix" },
  { pattern: /\bHUMAN\s*:/gi, name: "role_prefix" },
  { pattern: /\bSYSTEM\s*:/gi, name: "role_prefix" },
  { pattern: /<<\s*SYS\s*>>/gi, name: "system_tag" },
  { pattern: /<<\s*\/SYS\s*>>/gi, name: "system_tag" },
]
/* eslint-enable security/detect-unsafe-regex */

const MAX_INSTRUCTION_LENGTH = 10_000
const MAX_OUTPUT_FIELD_LENGTH = 64 * 1024

// Map common Cyrillic/Greek lookalikes back to ASCII so obfuscated
// instruction-override words are still caught after NFKC normalization.
const HOMOGLYPH_MAP: Record<string, string> = {
  а: "a", // U+0430
  е: "e", // U+0435
  о: "o", // U+043E
  р: "p", // U+0440
  с: "c", // U+0441
  у: "y", // U+0443
  х: "x", // U+0445
  і: "i", // U+0456
  ј: "j", // U+0458
  ε: "e", // U+03B5
  ο: "o", // U+03BF
}
const HOMOGLYPH_RE = /[аеорсухіјεο]/g

function normalizeInput(input: string): string {
  const withoutInvisible = input.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, "")
  const normalized = withoutInvisible.normalize("NFKC")
  const decoded = normalized.replace(
    /&(?:#x([0-9a-fA-F]+);|#([0-9]+);|amp;|lt;|gt;|quot;|apos;)/g,
    (_match, hex, decimal) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16))
      if (decimal) return String.fromCharCode(parseInt(decimal, 10))
      return { "amp;": "&", "lt;": "<", "gt;": ">", "quot;": '"', "apos;": "'" }[
        _match.slice(1)
      ] as string
    }
  )
  const withMappedHomoglyphs = decoded.replace(HOMOGLYPH_RE, (char) => HOMOGLYPH_MAP[char] ?? char)
  return withMappedHomoglyphs.replace(/\s+/g, " ").trim()
}

function detectInstructionPatterns(input: string): string[] {
  const normalized = normalizeInput(input)
  const detectedPatterns: string[] = []

  for (const { pattern, name } of INSTRUCTION_BOUNDARY_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(normalized)) {
      detectedPatterns.push(name)
    }
  }

  for (const { pattern, name } of CONTEXT_BOUNDARY_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(normalized)) {
      detectedPatterns.push(name)
    }
  }

  return [...new Set(detectedPatterns)]
}

export function checkInstructionSafety(input: string): InstructionSafetyResult {
  if (input.length > MAX_INSTRUCTION_LENGTH) {
    return {
      safe: false,
      reason: `Instruction exceeds maximum length of ${MAX_INSTRUCTION_LENGTH} characters`,
      detectedPatterns: ["input_too_long"],
    }
  }

  const detectedPatterns = detectInstructionPatterns(input)

  if (detectedPatterns.length > 0) {
    return {
      safe: false,
      reason: `Prompt injection risk detected: ${detectedPatterns.join(", ")}`,
      detectedPatterns,
    }
  }

  return { safe: true, detectedPatterns: [] }
}

export function sanitizeInstructionInput(input: string): string {
  const normalized = normalizeInput(input)
  let sanitized = normalized
  for (const { pattern } of INSTRUCTION_BOUNDARY_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]")
  }
  for (const { pattern } of CONTEXT_BOUNDARY_PATTERNS) {
    sanitized = sanitized.replace(pattern, " ")
  }
  return sanitized.replace(/\s+/g, " ").trim().slice(0, MAX_INSTRUCTION_LENGTH)
}

export function containsPromptInjection(input: string): boolean {
  return !checkInstructionSafety(input).safe
}

/**
 * Check engine-generated text fields for prompt-injection artifacts.
 * Uses a larger length limit than instruction input because findings can
 * legitimately contain long descriptions and code snippets.
 */
export function checkOutputSafety(input: string): InstructionSafetyResult {
  if (input.length > MAX_OUTPUT_FIELD_LENGTH) {
    return {
      safe: false,
      reason: `Output field exceeds maximum length of ${MAX_OUTPUT_FIELD_LENGTH} characters`,
      detectedPatterns: ["output_too_long"],
    }
  }

  const detectedPatterns = detectInstructionPatterns(input)

  if (detectedPatterns.length > 0) {
    return {
      safe: false,
      reason: `Prompt injection artifact detected in output: ${detectedPatterns.join(", ")}`,
      detectedPatterns,
    }
  }

  return { safe: true, detectedPatterns: [] }
}
