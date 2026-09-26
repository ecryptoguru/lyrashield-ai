import { describe, expect, it } from "vitest"
import {
  appendRuntimeCheck,
  buildTargetIdentityCheck,
  createRuntimeReceipt,
  finalizeRuntimeReceipt,
  hasRuntimeTargetIdentity,
  isCanonicalOrigin,
  recordRuntimeLimit,
  sanitizeOrigin,
  summarizeRuntimeReceipt,
  validateWebMcpRuntimeReceipt,
  WEBMCP_RUNTIME_CHECK_IDS,
  WEBMCP_RUNTIME_RECEIPT_VERSION,
  WebMcpRuntimeInputError,
  type WebMcpRuntimeReceipt,
} from "./runtime-receipt"

const CHECKSUM = "a".repeat(64)

function baseReceipt(): WebMcpRuntimeReceipt {
  return createRuntimeReceipt({
    runId: "run-test-1",
    checkedAt: "2026-09-26T00:00:00.000Z",
    browser: { name: "chromium", version: "1234.0.0.0", nativeApiAvailable: false },
    target: {
      url: "http://127.0.0.1:3000/fixtures/registered-tools.html",
      contentChecksum: CHECKSUM,
    },
  })
}

describe("sanitizeOrigin", () => {
  it("reduces a full URL to its canonical origin, dropping path/query/fragment", () => {
    expect(sanitizeOrigin("https://Example.COM:443/a/b?x=1#frag")).toBe("https://example.com")
    expect(sanitizeOrigin("http://example.com:8080/p?q#f")).toBe("http://example.com:8080")
  })

  it("rejects userinfo instead of silently stripping credentials", () => {
    for (const url of [
      "https://user@example.com/",
      "https://user:pass@example.com/path",
      "http://token@127.0.0.1:8080/",
    ]) {
      expect(() => sanitizeOrigin(url, { allowLoopback: true })).toThrow(WebMcpRuntimeInputError)
      expect(() => sanitizeOrigin(url, { allowLoopback: true })).toThrow(/userinfo/)
    }
  })

  it("rejects non-http(s) schemes for page targets but admits ws(s) for declared origins", () => {
    expect(() => sanitizeOrigin("file:///etc/passwd")).toThrow(/scheme/)
    expect(() => sanitizeOrigin("javascript:alert(1)")).toThrow()
    expect(() => sanitizeOrigin("wss://example.com/socket")).toThrow(/scheme/)
    expect(sanitizeOrigin("wss://example.com/socket", { allowAnyOriginSchemes: true })).toBe(
      "wss://example.com"
    )
  })

  it("rejects loopback without opt-in and permits it with", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.2:9000/",
      "http://[::1]:3000/",
      "http://0x7f000001/",
    ]) {
      expect(() => sanitizeOrigin(url)).toThrow(/loopback/)
    }
    expect(sanitizeOrigin("http://127.0.0.1:4000/x", { allowLoopback: true })).toBe(
      "http://127.0.0.1:4000"
    )
  })

  it("rejects relative and empty inputs", () => {
    for (const input of ["", "  ", "/relative/path", "example.com/path", "not a url"]) {
      expect(() => sanitizeOrigin(input)).toThrow(WebMcpRuntimeInputError)
    }
  })

  it("recognizes canonical form via isCanonicalOrigin", () => {
    expect(isCanonicalOrigin("https://example.com")).toBe(true)
    expect(isCanonicalOrigin("https://example.com/")).toBe(false)
    expect(isCanonicalOrigin("https://example.com/path")).toBe(false)
    expect(isCanonicalOrigin("http://127.0.0.1:3000")).toBe(false)
    expect(isCanonicalOrigin("http://127.0.0.1:3000", { allowLoopback: true })).toBe(true)
  })
})

describe("createRuntimeReceipt", () => {
  it("stores only the canonical origin, never path/query/fragment", () => {
    const receipt = baseReceipt()
    expect(receipt.schemaVersion).toBe(WEBMCP_RUNTIME_RECEIPT_VERSION)
    expect(receipt.target.origin).toBe("http://127.0.0.1:3000")
    expect(JSON.stringify(receipt.target)).not.toContain("registered-tools")
  })

  it("rejects a target URL carrying userinfo", () => {
    expect(() =>
      createRuntimeReceipt({
        browser: { name: "chromium", version: "1", nativeApiAvailable: false },
        target: { url: "https://user:pw@example.com/page" },
      })
    ).toThrow(/userinfo/)
  })

  it("marks identity-bound receipts PASS on webmcp.target-identity", () => {
    const receipt = baseReceipt()
    const identity = receipt.checks.find((c) => c.id === WEBMCP_RUNTIME_CHECK_IDS.targetIdentity)
    expect(identity?.state).toBe("PASS")
    expect(hasRuntimeTargetIdentity(receipt.target)).toBe(true)
  })

  it("marks identity-free receipts INCONCLUSIVE on webmcp.target-identity", () => {
    const receipt = createRuntimeReceipt({
      browser: { name: "chromium", version: "1", nativeApiAvailable: false },
      target: { url: "https://example.com/" },
    })
    expect(hasRuntimeTargetIdentity(receipt.target)).toBe(false)
    const identity = receipt.checks.find((c) => c.id === WEBMCP_RUNTIME_CHECK_IDS.targetIdentity)
    expect(identity?.state).toBe("INCONCLUSIVE")
    // …but the receipt itself remains schema-valid.
    expect(validateWebMcpRuntimeReceipt(receipt).ok).toBe(true)
    expect(buildTargetIdentityCheck(receipt.target).state).toBe("INCONCLUSIVE")
  })
})

describe("check-state transitions and summary", () => {
  it("FAIL dominates INCONCLUSIVE, which dominates PASS; empty is EMPTY", () => {
    const receipt = createRuntimeReceipt({
      browser: { name: "chromium", version: "1", nativeApiAvailable: false },
      target: { url: "https://example.com/", contentChecksum: CHECKSUM },
    })
    // Only the identity check (PASS) so far.
    expect(summarizeRuntimeReceipt(receipt).overall).toBe("PASS")

    appendRuntimeCheck(receipt, {
      id: WEBMCP_RUNTIME_CHECK_IDS.nativeApi,
      state: "INCONCLUSIVE",
      method: "native-browser",
      summary: "native WebMCP API unavailable in chromium 1",
    })
    expect(summarizeRuntimeReceipt(receipt).overall).toBe("INCONCLUSIVE")

    appendRuntimeCheck(receipt, {
      id: WEBMCP_RUNTIME_CHECK_IDS.declaredOrigins,
      state: "FAIL",
      method: "native-browser",
      summary: "1 request to an undeclared origin was blocked",
    })
    const summary = summarizeRuntimeReceipt(receipt)
    expect(summary.overall).toBe("FAIL")
    expect(summary.counts).toEqual({ PASS: 1, FAIL: 1, INCONCLUSIVE: 1, NOT_APPLICABLE: 0 })
  })

  it("appended checks are validated before recording", () => {
    const receipt = baseReceipt()
    expect(() =>
      appendRuntimeCheck(receipt, {
        id: "x",
        // @ts-expect-error state outside the vocabulary
        state: "MOSTLY-PASS",
        method: "native-browser",
        summary: "bad",
      })
    ).toThrow()
    expect(() =>
      appendRuntimeCheck(receipt, {
        id: "x",
        state: "PASS",
        // @ts-expect-error shim-derived evidence may not claim native-browser
        method: "js-shim",
        summary: "bad",
      })
    ).toThrow()
  })

  it("records timeouts and skipped check ids", () => {
    const receipt = baseReceipt()
    recordRuntimeLimit(receipt, { timedOut: true, skip: WEBMCP_RUNTIME_CHECK_IDS.toolEnumeration })
    recordRuntimeLimit(receipt, { skip: WEBMCP_RUNTIME_CHECK_IDS.toolEnumeration })
    expect(receipt.limits.timedOut).toBe(true)
    expect(receipt.limits.skipped).toEqual([WEBMCP_RUNTIME_CHECK_IDS.toolEnumeration])
  })
})

describe("validateWebMcpRuntimeReceipt / finalizeRuntimeReceipt", () => {
  it("round-trips a well-formed receipt", () => {
    const receipt = baseReceipt()
    const result = validateWebMcpRuntimeReceipt(JSON.parse(JSON.stringify(receipt)))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.receipt.target.contentChecksum).toBe(CHECKSUM)
    expect(finalizeRuntimeReceipt(receipt)).toEqual(receipt)
  })

  it("rejects a receipt whose origin was not sanitized", () => {
    const receipt = baseReceipt()
    for (const origin of [
      "http://127.0.0.1:3000/page?q=1",
      "http://user:pw@127.0.0.1:3000",
      "ftp://example.com",
      "not-a-url",
    ]) {
      const tampered = { ...receipt, target: { ...receipt.target, origin } }
      const result = validateWebMcpRuntimeReceipt(tampered)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(" ")).toMatch(/origin/)
    }
  })

  it("rejects unknown top-level fields and wrong schema versions", () => {
    const receipt = baseReceipt()
    expect(validateWebMcpRuntimeReceipt({ ...receipt, cookies: "session=abc" }).ok).toBe(false)
    expect(validateWebMcpRuntimeReceipt({ ...receipt, schemaVersion: "other/9" }).ok).toBe(false)
    expect(validateWebMcpRuntimeReceipt(null).ok).toBe(false)
    expect(validateWebMcpRuntimeReceipt("x").ok).toBe(false)
  })

  it("rejects malformed browser/check/limit shapes", () => {
    const receipt = baseReceipt()
    expect(
      validateWebMcpRuntimeReceipt({
        ...receipt,
        browser: { name: "chromium", version: "1" },
      }).ok
    ).toBe(false)
    expect(
      validateWebMcpRuntimeReceipt({
        ...receipt,
        checks: [{ id: "x", state: "PASS", method: "native-browser" }],
      }).ok
    ).toBe(false)
    expect(
      validateWebMcpRuntimeReceipt({
        ...receipt,
        limits: { timedOut: "no", skipped: [] },
      }).ok
    ).toBe(false)
  })
})
