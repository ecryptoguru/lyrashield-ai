import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { assertSafeBillingE2EBaseUrl } from "../../../e2e/billing/base-url-safety"

describe("billing E2E origin safety", () => {
  it("accepts only the exact explicitly staged remote host", () => {
    expect(() =>
      assertSafeBillingE2EBaseUrl(
        "https://lyrashield-billing-staging.example.net",
        "lyrashield-billing-staging.example.net",
        true
      )
    ).not.toThrow()
    expect(() =>
      assertSafeBillingE2EBaseUrl(
        "https://other-staging.example.net",
        "lyrashield-billing-staging.example.net",
        true
      )
    ).toThrow(/exactly match/)
  })

  it.each([
    "https://app.lyrashieldai.com",
    "https://lyrashield-app.icyglacier-d3526777.centralindia.azurecontainerapps.io",
    "https://lyrashield-scanner.icyglacier-d3526777.centralindia.azurecontainerapps.io",
  ])("rejects known production host %s", (url) => {
    expect(() => assertSafeBillingE2EBaseUrl(url, new URL(url).hostname, true)).toThrow(
      /production/
    )
  })

  it("rejects a remote host without an explicit staging marker", () => {
    expect(() =>
      assertSafeBillingE2EBaseUrl("https://billing.example.net", "billing.example.net", true)
    ).toThrow(/staging marker/)
  })

  it("keeps trace capture off while an access header can be present", () => {
    const config = readFileSync(
      fileURLToPath(new URL("../../../playwright.config.ts", import.meta.url)),
      "utf8"
    )
    expect(config).toContain('trace: accessHeaderConfigured ? "off" : "retain-on-failure"')
  })
})
