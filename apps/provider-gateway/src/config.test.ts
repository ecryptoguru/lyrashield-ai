import { describe, expect, it } from "vitest"
import { loadProviderGatewayConfig } from "./config"
import { fixturePolicy } from "./test-fixtures"

describe("unqualified gateway entrypoint", () => {
  it("refuses to open even if an operator supplies the open flag", () => {
    expect(() => loadProviderGatewayConfig({ LYRASHIELD_RUNTIME_ADMISSION: "open" })).toThrow(
      /held until broker and journal qualification/
    )
  })
})

const syntheticEnv = (baseUrl = "https://provider.example.test") => ({
  LYRASHIELD_PROVIDER_GATEWAY_JOURNAL_PATH: "/synthetic/journal.jsonl",
  LYRASHIELD_PROVIDER_GATEWAY_SIGNING_SECRET: "s".repeat(48),
  LYRASHIELD_PROVIDER_GATEWAY_RESPONSE_ENCRYPTION_SECRET: "e".repeat(48),
  LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN: "c".repeat(48),
  FIXTURE_PROVIDER_KEY: "synthetic-provider-secret",
  LYRASHIELD_PROVIDER_ROUTES_JSON: JSON.stringify([
    {
      id: "azure-ai",
      baseUrl,
      authKind: "authorization",
      secretEnv: "FIXTURE_PROVIDER_KEY",
      allowedPathPrefixes: ["/openai/"],
      requestPolicy: fixturePolicy,
    },
  ]),
})

describe("provider route configuration", () => {
  it("loads a versioned policy while remaining closed by default", () => {
    const config = loadProviderGatewayConfig(syntheticEnv())
    expect(config.admission).toBe("closed")
    expect(config.providers.get("azure-ai")?.requestPolicy).toEqual(fixturePolicy)
    expect(config.responseEncryptionSecret).toBe("e".repeat(48))
  })
  it.each([
    "http://provider.example.test",
    "ftp://localhost",
    "https://user:password@provider.example.test",
    "https://provider.example.test?api-key=secret",
    "https://provider.example.test#fragment",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => loadProviderGatewayConfig(syntheticEnv(baseUrl))).toThrow()
  })
})
