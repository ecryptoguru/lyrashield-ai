import { logger } from "@lyrashield/logger"

export interface GuardResult {
  allowed: boolean
  reason?: string
  sanitizedInput?: string
  detectedPatterns: string[]
}

/* eslint-disable security/detect-unsafe-regex */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
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
  {
    pattern:
      /execute\s+(?:arbitrary\s+)?code|run\s+(?:this|the|following|arbitrary\s+)?code|exec\s*\(|execSync\s*\(|execFile\s*\(|spawn\s*\(|fork\s*\(|spawnSync\s*\(/gi,
    name: "code_execution",
  },
  {
    pattern: /eval\s*\(|new\s+Function\s*\(|Function\s*\(|setTimeout\s*\(|setInterval\s*\(/gi,
    name: "code_execution",
  },
  {
    pattern: /require\s*\(|module\.exports|exports\.|import\s*\(|import\s+/gi,
    name: "code_execution",
  },
  { pattern: /child_process|child-process|childprocess/gi, name: "code_execution" },
  {
    pattern: /process\.env|process\.env\.|global\.process|Buffer\.from|process\.mainModule/gi,
    name: "env_extraction",
  },
  { pattern: /file:\/\/\//gi, name: "file_access" },
  {
    pattern: /\/etc\/passwd|\.\/\.\.|\.\.\/%2f|%2e%2e|\\x2e\\x2e|__proto__|constructor|prototype/gi,
    name: "file_access",
  },
  {
    pattern:
      /rm\s+-rf|rm\s+-r\s+\/|rm\s+-rf\s+\/|del\s+\/f\/s\/q|format\s+\/|mkfs\.|dd\s+if=.*of=\/dev/gi,
    name: "destructive_command",
  },
  {
    pattern: /DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE|ALTER\s+TABLE\s+.*\s+DROP/gi,
    name: "sql_injection",
  },
  {
    pattern:
      /;\s*DELETE\s+FROM|;\s*UPDATE\s+.*\s+SET|;\s*INSERT\s+INTO|;\s*ALTER\s+|;\s*CREATE\s+/gi,
    name: "sql_injection",
  },
  { pattern: /\bUNION\s+SELECT\b|\bUNION\s+ALL\s+SELECT\b/gi, name: "sql_injection" },
  {
    pattern:
      /javascript:|vbscript:|data:text\/html|data:application\/javascript|data:image\/svg\+xml/gi,
    name: "xss_vector",
  },
  {
    pattern:
      /<script\b|on(?:error|load|click|dblclick|mousedown|mouseup|mouseover|mouseout|mouseenter|mouseleave|mousemove|mousewheel|wheel|keypress|keydown|keyup|submit|reset|select|change|input|contextmenu|drag|drop|dragstart|dragend|dragenter|dragleave|dragover|blur|focus|focusin|focusout|scroll|copy|cut|paste|abort|canplay|canplaythrough|cuechange|durationchange|emptied|ended|loadeddata|loadedmetadata|loadstart|pause|play|playing|progress|ratechange|seeked|seeking|stalled|suspend|timeupdate|volumechange|waiting|toggle|invalid|pointerdown|pointerup|pointermove|pointerover|pointerout|pointerenter|pointerleave|pointercancel|gotpointercapture|lostpointercapture|touchstart|touchend|touchmove|touchcancel|auxclick|beforeinput|compositionstart|compositionupdate|compositionend|fullscreenchange|fullscreenerror|animationstart|animationend|animationiteration|transitionstart|transitionend|transitioncancel|transitionrun|beforeprint|afterprint|beforeunload|hashchange|popstate|pageshow|pagehide|message|messageerror|offline|online|rejectionhandled|unhandledrejection|storage|visibilitychange|load|unload|resize|error)\s*=/gi,
    name: "xss_vector",
  },
  {
    pattern:
      /atob\s*\(|btoa\s*\(|String\.fromCharCode\s*\(|String\.fromCodePoint\s*\(|decodeURIComponent\s*\(|unescape\s*\(/gi,
    name: "obfuscation",
  },
  {
    pattern:
      /base64\s*(?:encode|decode)|rot13|rot-13|caesar\s* cipher|morse\s*code|binary\s*encode|hex\s*decode|url\s*decode|encodeURIComponent\s*\(/gi,
    name: "obfuscation",
  },
  {
    pattern:
      /prompt\s*injection|adversarial|grandma\s+exploit|token\s+smuggling|ignore\s+the\s+above|do\s+not\s+reveal|do\s+not\s+disclose|do\s+not\s+share|do\s+not\s+tell|do\s+not\s+mention|do\s+not\s+explain|do\s+not\s+provide|do\s+not\s+generate|do\s+not\s+write|do\s+not\s+say|do\s+not\s+respond|do\s+not\s+answer|do\s+not\s+include|do\s+not\s+contain|do\s+not\s+have|do\s+not\s+make|do\s+not\s+perform|do\s+not\s+execute|do\s+not\s+run|do\s+not\s+call|do\s+not\s+use|do\s+not\s+trigger|do\s+not\s+start|do\s+not\s+begin|do\s+not\s+initiate|do\s+not\s+launch|do\s+not\s+create|do\s+not\s+make|do\s+not\s+schedule|do\s+not\s+enqueue|do\s+not\s+output|do\s+not\s+print|do\s+not\s+echo/gi,
    name: "instruction_override",
  },
]

const CONTEXT_BOUNDARY_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\n\s*---\s*\n/g, name: "markdown_separator" },
  { pattern: /\n\s*\*\*\*\s*\n/g, name: "markdown_separator" },
  { pattern: /\[INST\]/gi, name: "instruction_tag" },
  { pattern: /\[\/INST\]/gi, name: "instruction_tag" },
  { pattern: /<\|im_start\|>/gi, name: "chatml_tag" },
  { pattern: /<\|im_end\|>/gi, name: "chatml_tag" },
  { pattern: /\n\s*###\s*\n/g, name: "markdown_separator" },
  { pattern: /\n\s*===\s*\n/g, name: "markdown_separator" },
  { pattern: /\n\s*USER\s*:/gi, name: "role_prefix" },
  { pattern: /\n\s*ASSISTANT\s*:/gi, name: "role_prefix" },
  { pattern: /\n\s*HUMAN\s*:/gi, name: "role_prefix" },
  { pattern: /\n\s*SYSTEM\s*:/gi, name: "role_prefix" },
  { pattern: /<<\s*SYS\s*>>/gi, name: "system_tag" },
  { pattern: /<<\s*\/SYS\s*>>/gi, name: "system_tag" },
]
/* eslint-enable security/detect-unsafe-regex */

export class PromptInjectionGuard {
  private maxInputLength: number
  private strictMode: boolean

  constructor(options?: { maxInputLength?: number; strictMode?: boolean }) {
    this.maxInputLength = options?.maxInputLength ?? 10000
    this.strictMode = options?.strictMode ?? true
  }

  /**
   * Normalize input so that trivial obfuscation (zero-width characters,
   * Unicode homoglyphs, extra whitespace, HTML entities) cannot bypass the
   * regex patterns.
   */
  private normalizeInput(input: string): string {
    // Remove zero-width and invisible control characters commonly used to
    // break string-based filters.
    const withoutInvisible = input.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, "")

    // Normalize Unicode (NFKC) to collapse homoglyphs such as "і" (Cyrillic)
    // vs "i" (Latin).
    const normalized = withoutInvisible.normalize("NFKC")

    // Decode common HTML entities used to hide characters.
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

    // Collapse repeated whitespace and trim.
    return decoded.replace(/\s+/g, " ").trim()
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

    const normalized = this.normalizeInput(input)

    for (const { pattern, name } of INJECTION_PATTERNS) {
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

    const CRITICAL_PATTERN_NAMES = new Set([
      "instruction_override",
      "role_hijack",
      "code_execution",
      "sql_injection",
      "destructive_command",
      "env_extraction",
      "prompt_extraction",
      "file_access",
      "obfuscation",
      "system_prefix",
      "system_tag",
      "prompt_tag",
      "instruction_injection",
      "memory_wipe",
      "instruction_tag",
      "chatml_tag",
      "role_prefix",
      "markdown_separator",
    ])
    const criticalPatterns = detectedPatterns.filter((p) => CRITICAL_PATTERN_NAMES.has(p))

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
