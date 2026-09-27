import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hashPrivacyValue } from "./privacy-hash"

describe("hashPrivacyValue", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("uses the configured salt for a stable SHA-256 hash", async () => {
    vi.stubEnv("IP_HASH_SALT", "s".repeat(32))
    await expect(hashPrivacyValue("203.0.113.8")).resolves.toBe(
      createHash("sha256").update(`203.0.113.8${"s".repeat(32)}`).digest("hex")
    )
  })

  it.each([undefined, "short"])("fails closed without a strong salt (%s)", async (salt) => {
    vi.stubEnv("IP_HASH_SALT", salt)
    await expect(hashPrivacyValue("203.0.113.8")).rejects.toThrow("IP_HASH_SALT")
  })
})
