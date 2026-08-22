import { describe, expect, it } from "vitest"
import { decryptRetrievalKey, encryptRetrievalKey } from "./license-fulfillment"

describe("license fulfillment retrieval custody", () => {
  it("encrypts one-time raw keys at rest and round-trips only in process memory", () => {
    const rawKey = "LYRA-11111111-2222-3333-4444-555555555555"
    const encrypted = encryptRetrievalKey(rawKey)

    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain(rawKey)
    expect(decryptRetrievalKey(encrypted)).toBe(rawKey)
  })
})
