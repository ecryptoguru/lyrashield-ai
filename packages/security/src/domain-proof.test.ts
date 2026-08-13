import { describe, expect, it } from "vitest"
import {
  domainProofTxtName,
  hasDomainProofToken,
  normalizeDomainForProof,
  verifyDomainProofToken,
} from "./domain-proof"

const token = "a".repeat(48)

describe("domain proof", () => {
  it("normalizes an HTTPS hostname and produces one predictable TXT name", () => {
    expect(normalizeDomainForProof("https://Staging.Example.com/path")).toBe("staging.example.com")
    expect(domainProofTxtName("staging.example.com")).toBe("_lyrashield.staging.example.com")
  })

  it.each(["127.0.0.1", "localhost", "foo.localhost", "not a host", "https://"])(
    "rejects an unsafe or non-domain proof target: %s",
    (value) => expect(normalizeDomainForProof(value)).toBeNull()
  )

  it("accepts only the complete DNS proof token", async () => {
    expect(hasDomainProofToken([[token.slice(0, 20), token.slice(20)]], token)).toBe(true)
    await expect(
      verifyDomainProofToken("example.com", token, async () => [
        [token.slice(0, 20), token.slice(20)],
      ])
    ).resolves.toBe(true)
    await expect(
      verifyDomainProofToken("example.com", token, async () => [["wrong"]])
    ).resolves.toBe(false)
  })

  it("fails closed when DNS cannot be resolved", async () => {
    await expect(
      verifyDomainProofToken("example.com", token, async () => Promise.reject(new Error("dns")))
    ).resolves.toBe(false)
  })
})
