import { describe, it, expect } from "vitest"
import { canonicalizeIpv4, expandIpv6, parseIpLiteral, isBlockedIp } from "./ssrf"

/**
 * ReDoS (Regular Expression Denial of Service) guard tests.
 *
 * These tests verify that regex patterns used in input validation and parsing
 * do not exhibit catastrophic backtracking when fed adversarial inputs. Each
 * test runs the pattern/function against a crafted input that would cause
 * exponential backtracking in a vulnerable pattern (e.g., `(a+)+`, `(a*)*`,
 * nested quantifiers) and asserts it completes quickly.
 *
 * The timeout is set via vitest's per-test timeout (default 5s). A vulnerable
 * pattern would hang for minutes or longer, so even a generous timeout is
 * sufficient to catch ReDoS.
 */

// Patterns extracted from the codebase that process untrusted input.
// Each is tested directly to ensure it does not exhibit catastrophic backtracking.

describe("ReDoS guard — SSRF IPv4 parsing patterns", () => {
  it("canonicalizeIpv4 does not hang on adversarial dotted strings", () => {
    // A pattern like ^[0-9]+$ applied to a long string of digits is linear,
    // but a crafted input with mixed characters and dots could stress a
    // vulnerable pattern. This input has 10,000 characters.
    const adversarial = "1".repeat(5000) + "." + "2".repeat(5000)
    const result = canonicalizeIpv4(adversarial)
    // Should be null (too many digits per octet) but must not hang.
    expect(result).toBeNull()
  })

  it("canonicalizeIpv4 handles hex-prefixed parts without backtracking", () => {
    const adversarial = "0x" + "f".repeat(10000)
    const result = canonicalizeIpv4(adversarial)
    expect(result).toBeNull()
  })

  it("canonicalizeIpv4 handles octal-prefixed parts without backtracking", () => {
    const adversarial = "0" + "7".repeat(10000)
    const result = canonicalizeIpv4(adversarial)
    expect(result).toBeNull()
  })

  it("canonicalizeIpv4 handles mixed valid/invalid parts quickly", () => {
    const adversarial = "1.2.3." + "x".repeat(5000)
    const result = canonicalizeIpv4(adversarial)
    expect(result).toBeNull()
  })
})

describe("ReDoS guard — IPv6 hex group validation", () => {
  it("expandIpv6 does not hang on long hex groups", () => {
    // The pattern ^[0-9a-f]{1,4}$ is bounded (max 4 chars), but test with
    // a long string to ensure the split + per-group test is linear.
    const adversarial = "f".repeat(10000)
    const result = expandIpv6(adversarial)
    expect(result).toBeNull()
  })

  it("expandIpv6 handles many colons without backtracking", () => {
    const adversarial = ":".repeat(1000) + "1"
    const result = expandIpv6(adversarial)
    expect(result).toBeNull()
  })

  it("parseIpLiteral handles long bracketed IPv6 without hanging", () => {
    const adversarial = `[${"f".repeat(10000)}]`
    const result = parseIpLiteral(adversarial)
    expect(result).toBeNull()
  })
})

describe("ReDoS guard — isBlockedIp with adversarial inputs", () => {
  it("isBlockedIp does not hang on long IPv4 strings", () => {
    const adversarial = "10." + "0".repeat(5000) + ".0.1"
    const result = isBlockedIp(adversarial)
    // canonicalizeIpv4 treats the oversized octet as 0 (parseInt("000…0")
    // → 0), so the address canonicalizes to 10.0.0.1 which IS in the
    // 10.0.0.0/8 blocked range. The key assertion is that it does not hang.
    expect(result).toBe(true)
  })
})

describe("ReDoS guard — API key format regex", () => {
  // Test the pattern /^[A-Za-z0-9_-]+$/ which is used in isApiKeyFormat.
  // This pattern is linear (single quantifier over a character class), but
  // we verify it does not hang on a long input.
  it("linear character-class pattern does not hang on long input", () => {
    const pattern = /^[A-Za-z0-9_-]+$/
    const adversarial = "a".repeat(100_000)
    // This should complete in well under 1s.
    const result = pattern.test(adversarial)
    expect(result).toBe(true)
  })

  it("linear character-class pattern rejects mixed input quickly", () => {
    const pattern = /^[A-Za-z0-9_-]+$/
    // A long string that almost matches but has a non-matching char at the end.
    const adversarial = "a".repeat(50_000) + "!" + "b".repeat(50_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })
})

describe("ReDoS guard — URL validation (z.url / WHATWG URL parser)", () => {
  it("WHATWG URL parser does not hang on long scheme-like input", () => {
    // The URL constructor is used for URL validation. A long string that
    // looks like a URL with a very long scheme name should not hang.
    // The WHATWG URL parser accepts arbitrary-length scheme names (any
    // ASCII alpha followed by ASCII alphanumeric/+/-/.), so this input
    // is actually valid. The key assertion is that it does not hang.
    const adversarial = "h" + "t".repeat(10_000) + "p://example.com"
    const url = new URL(adversarial)
    expect(url.hostname).toBe("example.com")
  })

  it("WHATWG URL parser handles long paths without backtracking", () => {
    const adversarial = "https://example.com/" + "a".repeat(50_000)
    const url = new URL(adversarial)
    expect(url.hostname).toBe("example.com")
  })

  it("WHATWG URL parser handles long query strings without backtracking", () => {
    const adversarial = "https://example.com?q=" + "x".repeat(50_000)
    const url = new URL(adversarial)
    expect(url.hostname).toBe("example.com")
  })
})

describe("ReDoS guard — repo owner/name regex", () => {
  // Pattern: /^[A-Za-z0-9_.-]+$/ — used for repoOwner and repoName validation.
  it("does not hang on long valid input", () => {
    const pattern = /^[A-Za-z0-9_.-]+$/
    const adversarial = "a".repeat(100_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(true)
  })

  it("does not hang on long input with trailing invalid char", () => {
    const pattern = /^[A-Za-z0-9_.-]+$/
    const adversarial = "a".repeat(50_000) + " " + "b".repeat(50_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })
})

describe("ReDoS guard — control character regex", () => {
  // Pattern: /[\u0000-\u001F\u007F]/ — used in workspace/project/target name validation.
  it("does not hang on long input without control characters", () => {
    const pattern = /[\u0000-\u001F\u007F]/
    const adversarial = "a".repeat(100_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })

  it("does not hang on long input with control character at end", () => {
    const pattern = /[\u0000-\u001F\u007F]/
    const adversarial = "a".repeat(50_000) + "\u0000" + "b".repeat(50_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(true)
  })
})

describe("ReDoS guard — Supabase JWT pattern", () => {
  // Pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  // This has quantifiers separated by literal dots, which is safe, but
  // test with adversarial input to confirm.
  it("does not hang on long input matching the pattern prefix", () => {
    const pattern = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
    const adversarial = "eyJ" + "A".repeat(50_000)
    pattern.lastIndex = 0
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })

  it("does not hang on long input with dots in wrong places", () => {
    const pattern = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
    const adversarial =
      "eyJ" + "A".repeat(25_000) + "." + "eyJ" + "B".repeat(25_000) + "." + "C".repeat(25_000)
    pattern.lastIndex = 0
    const result = pattern.test(adversarial)
    expect(result).toBe(true)
  })
})

describe("ReDoS guard — GPT-5.6 model name pattern", () => {
  // Pattern: /(?:^|[/.-])gpt-5\.6-(?:terra|luna)(?:$|[/.-])/
  // This uses alternation, not nested quantifiers, so it is safe.
  it("does not hang on long input without the pattern", () => {
    const pattern = /(?:^|[/.-])gpt-5\.6-(?:terra|luna)(?:$|[/.-])/
    const adversarial = "x".repeat(50_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })

  it("does not hang on long input with partial match", () => {
    const pattern = /(?:^|[/.-])gpt-5\.6-(?:terra|luna)(?:$|[/.-])/
    const adversarial = "gpt-5.6-" + "t".repeat(50_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })
})

describe("ReDoS guard — run name pattern", () => {
  // Pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  // Bounded quantifier {0,127} prevents catastrophic backtracking.
  it("does not hang on input exceeding the bounded length", () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
    const adversarial = "a".repeat(10_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })
})

describe("ReDoS guard — share token pattern", () => {
  // Pattern from packages/db/src/report-service.ts: /^[a-f0-9]{64}$/i
  // Fixed-length hex pattern — no nested quantifiers, but test with long input.
  it("fixed-length hex token pattern does not hang on long input", () => {
    const pattern = /^[a-f0-9]{64}$/i
    const adversarial = "a".repeat(100_000)
    const result = pattern.test(adversarial)
    expect(result).toBe(false)
  })
})
