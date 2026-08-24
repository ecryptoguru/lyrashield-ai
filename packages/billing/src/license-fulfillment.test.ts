import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { decryptRetrievalKey, encryptRetrievalKey } from "./license-fulfillment"

describe("license fulfillment retrieval custody", () => {
  it("uses statically traced Azure Key Vault modules in the standalone web build", async () => {
    // Fixed sibling source file; never test input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(
      fileURLToPath(new URL("./license-fulfillment.ts", import.meta.url)),
      "utf8"
    )

    expect(source).toContain('import { DefaultAzureCredential } from "@azure/identity"')
    expect(source).toContain('import { SecretClient } from "@azure/keyvault-secrets"')
    expect(source).not.toContain('require("@azure/identity")')
    expect(source).not.toContain('require("@azure/keyvault-secrets")')
  })

  it("puts retrieval tokens in URL fragments instead of request URLs", async () => {
    // Fixed sibling source file; never test input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = await readFile(
      fileURLToPath(new URL("./license-fulfillment.ts", import.meta.url)),
      "utf8"
    )

    expect(source).toContain("/licenses/retrieve#token=")
    expect(source).not.toContain("/api/licenses/retrieve?token=")
  })

  it("encrypts one-time raw keys at rest and round-trips only in process memory", () => {
    const rawKey = "LYRA-11111111-2222-3333-4444-555555555555"
    const encrypted = encryptRetrievalKey(rawKey)

    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain(rawKey)
    expect(decryptRetrievalKey(encrypted)).toBe(rawKey)
  })
})
