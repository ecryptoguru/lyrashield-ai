import { logger } from "@lyrashield/logger"

export interface GuardResult {
  allowed: boolean
  reason?: string
  sanitizedInput?: string
  detectedPatterns: string[]
}

// Patterns are static keyword/phrase alternations with non-nested optional quantifiers.
// Input is normalized and length-capped, so no catastrophic backtracking (ReDoS).
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

/**
 * Cross-script Unicode homoglyph mapping. NFKC normalization does not map
 * characters across scripts (e.g. Cyrillic "а" U+0430 → Latin "a" U+0061),
 * so without an explicit table an attacker can substitute lookalike
 * characters to bypass keyword-based patterns.
 *
 * The table covers the most commonly confused Latin/Cyrillic/Greek pairs.
 * It is intentionally conservative: only characters with a visually
 * indistinguishable Latin equivalent are included, to minimise false
 * positives on legitimate non-English input.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic → Latin
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  і: "i",
  І: "I",
  ј: "j",
  Ј: "J",
  ѕ: "s",
  Ѕ: "S",
  // Greek → Latin
  ο: "o",
  Ο: "O",
  ρ: "p",
  Ρ: "P",
  ν: "v",
  Ν: "N",
  α: "a",
  Α: "A",
  ε: "e",
  Ε: "E",
  η: "e",
  Η: "E",
  ι: "i",
  Ι: "I",
  κ: "k",
  Κ: "K",
  μ: "m",
  Μ: "M",
  τ: "t",
  Τ: "T",
  γ: "g",
  Γ: "G",
  β: "b",
  Β: "B",
}

/**
 * Leetspeak mapping. Attackers substitute digits and symbols for letters
 * to bypass keyword-based patterns. The table covers the most common
 * substitutions used in prompt-injection payloads.
 */
const LEETSPEAK_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
}

/**
 * Decode a string that appears to be base64-encoded and return the decoded
 * result. Returns null if the input does not look like base64 or if decoding
 * fails. This is intentionally conservative: only standalone tokens that
 * match the base64 alphabet and are long enough to be meaningful are decoded.
 */
function tryDecodeBase64(token: string): string | null {
  // Must be at least 20 chars (enough to encode a meaningful phrase), only
  // base64 alphabet characters, optional padding at the end.
  if (!/^[A-Za-z0-9+/]{20,}={0,2}$/.test(token)) return null
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8")
    // Reject if the decoded result is not mostly printable ASCII text.
    if (!/^[\x20-\x7E\s]+$/.test(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

export class PromptInjectionGuard {
  private maxInputLength: number
  private strictMode: boolean
  private timeoutMs: number
  private logEvents: boolean

  constructor(options?: {
    maxInputLength?: number
    strictMode?: boolean
    timeoutMs?: number
    logEvents?: boolean
  }) {
    this.maxInputLength = options?.maxInputLength ?? 10000
    this.strictMode = options?.strictMode ?? true
    this.timeoutMs = options?.timeoutMs ?? 1000
    this.logEvents = options?.logEvents ?? true
  }

  private isDeadlineExceeded(deadline: number): boolean {
    if (this.timeoutMs <= 0) return false
    return Date.now() > deadline
  }

  /**
   * Normalize input so that trivial obfuscation (zero-width characters,
   * Unicode homoglyphs, leetspeak, URL-encoding, HTML entities, base64)
   * cannot bypass the regex patterns.
   */
  private normalizeInput(input: string): string {
    // Replace zero-width and invisible control characters with a space so
    // that obfuscated words like "ignore\u200Ball\u200Binstructions" become
    // "ignore all instructions" (matching the pattern) rather than
    // "ignoreallinstructions" (which would bypass it).
    const withoutInvisible = input.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, " ")

    // Map cross-script Unicode homoglyphs to their Latin equivalents.
    // NFKC normalization handles compatibility characters (e.g. "ﬁ" → "fi")
    // but does NOT map cross-script lookalikes (Cyrillic "і" U+0456 ≠ Latin
    // "i" U+0069). Without this step, "іgnore" stays "іgnore" and bypasses
    // patterns that match "ignore".
    let homoglyphMapped = ""
    for (const char of withoutInvisible) {
      homoglyphMapped += HOMOGLYPH_MAP[char] ?? char
    }

    // Normalize Unicode (NFKC) to collapse compatibility characters.
    const normalized = homoglyphMapped.normalize("NFKC")

    // Decode URL percent-encoding (e.g. %69%67%6E%6F%72%65 → ignore).
    // Wrapped in try/catch because malformed sequences (e.g. "%xy") would
    // throw; in that case we keep the original string.
    let urlDecoded = normalized
    if (normalized.includes("%")) {
      try {
        urlDecoded = decodeURIComponent(normalized)
      } catch {
        // Malformed percent-encoding — keep original.
      }
    }

    // Decode common HTML entities used to hide characters.
    const htmlDecoded = urlDecoded.replace(
      /&(?:#x([0-9a-fA-F]+);|#([0-9]+);|amp;|lt;|gt;|quot;|apos;)/g,
      (_match, hex, decimal) => {
        if (hex) return String.fromCharCode(parseInt(hex, 16))
        if (decimal) return String.fromCharCode(parseInt(decimal, 10))
        return { "amp;": "&", "lt;": "<", "gt;": ">", "quot;": '"', "apos;": "'" }[
          _match.slice(1)
        ] as string
      }
    )

    // Attempt base64 decode on standalone tokens BEFORE leetspeak mapping,
    // because leetspeak digit-to-letter substitution would corrupt base64
    // content (e.g. "3" to "e" changes the base64 string). If a token
    // decodes to readable text, append the decoded form so injection
    // patterns can match against it.
    const b64Tokens = htmlDecoded.split(/\s+/)
    const b64Augmented: string[] = [htmlDecoded]
    for (const token of b64Tokens) {
      const decodedB64 = tryDecodeBase64(token)
      if (decodedB64) {
        b64Augmented.push(decodedB64)
      }
    }
    const b64Joined = b64Augmented.join(" ")

    // Map leetspeak digits/symbols to their letter equivalents. Applied
    // after URL-decode, HTML-entity-decode, and base64-decode so that
    // encoded leetspeak is also caught.
    let leetspeakMapped = ""
    for (const char of b64Joined) {
      leetspeakMapped += LEETSPEAK_MAP[char] ?? char
    }

    // Collapse repeated whitespace and trim.
    return leetspeakMapped.replace(/\s+/g, " ").trim()
  }

  check(input: string): GuardResult
  check(
    input: string,
    overrides?: { maxInputLength?: number; skipPatterns?: Set<string> }
  ): GuardResult
  check(
    input: string,
    overrides?: { maxInputLength?: number; skipPatterns?: Set<string> }
  ): GuardResult {
    const detectedPatterns: string[] = []
    const deadline = this.timeoutMs > 0 ? Date.now() + this.timeoutMs : 0
    const effectiveMaxLength = overrides?.maxInputLength ?? this.maxInputLength

    if (input.length > effectiveMaxLength) {
      return {
        allowed: false,
        reason: `Input exceeds maximum length of ${effectiveMaxLength} characters`,
        detectedPatterns: ["input_too_long"],
      }
    }

    const normalized = this.normalizeInput(input)

    for (const { pattern, name } of INJECTION_PATTERNS) {
      if (overrides?.skipPatterns?.has(name)) continue
      if (this.isDeadlineExceeded(deadline)) {
        this.logEvents &&
          logger.warn("Prompt injection guard exceeded time budget", {
            inputLength: input.length,
            timeoutMs: this.timeoutMs,
          })
        return {
          allowed: false,
          reason: "Prompt injection guard exceeded time budget",
          detectedPatterns: ["guard_timeout"],
        }
      }
      pattern.lastIndex = 0
      if (pattern.test(normalized)) {
        detectedPatterns.push(name)
      }
    }

    for (const { pattern, name } of CONTEXT_BOUNDARY_PATTERNS) {
      if (this.isDeadlineExceeded(deadline)) {
        this.logEvents &&
          logger.warn("Prompt injection guard exceeded time budget", {
            inputLength: input.length,
            timeoutMs: this.timeoutMs,
          })
        return {
          allowed: false,
          reason: "Prompt injection guard exceeded time budget",
          detectedPatterns: ["guard_timeout"],
        }
      }
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
      this.logEvents &&
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

    // The check_diff tool receives raw PR diffs that routinely exceed the
    // default 10000-char limit and legitimately contain code-execution and
    // env-extraction patterns. Raise the limit and skip those pattern classes
    // so the advisory scanner (which intentionally detects those patterns) sees
    // the diff instead of being blocked by the injection guard.
    const overrides =
      toolName === "lyrashield_check_diff"
        ? {
            maxInputLength: 200000,
            skipPatterns: new Set(["code_execution", "env_extraction"]),
          }
        : undefined
    const result = this.check(serialized, overrides)

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
