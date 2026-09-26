import { describe, expect, it } from "vitest"
import { parseWebMcpRuntimeReceipt } from "./runtime-receipt"

const receipt = {
  schemaVersion: "lyrashield-webmcp-runtime/1",
  runId: "1247e3b1-6c95-4f41-a60a-0759b0d9f539",
  checkedAt: "2026-09-26T12:00:00.000Z",
  browser: { name: "Chromium", version: "152", nativeApiAvailable: true },
  target: { origin: "http://127.0.0.1:4567", contentChecksum: "a".repeat(64) },
  checks: [
    {
      id: "DISCOVERY",
      state: "PASS",
      method: "native-browser",
      summary: "Native discovery observed.",
    },
  ],
  limits: { timedOut: false, skipped: [] },
}

describe("WebMCP runtime receipt", () => {
  it("accepts a bounded native observation", () => {
    expect(parseWebMcpRuntimeReceipt(receipt).checks[0]?.state).toBe("PASS")
  })

  it.each([
    { ...receipt, target: { origin: "http://user:secret@127.0.0.1:4567" } },
    { ...receipt, target: { origin: "http://127.0.0.1:4567/?token=secret" } },
    { ...receipt, cookie: "secret" },
    { ...receipt, checks: [{ ...receipt.checks[0], rawOutput: "secret" }] },
    { ...receipt, checks: [receipt.checks[0], receipt.checks[0]] },
    { ...receipt, browser: { ...receipt.browser, nativeApiAvailable: false } },
  ])("rejects secret-bearing or extra receipt data", (value) => {
    expect(() => parseWebMcpRuntimeReceipt(value)).toThrow()
  })
})
