import { describe, expect, it } from "vitest"
import { generateKeyPairSync } from "node:crypto"

import {
  signLaunchReportChecksum,
  verifyLaunchReportSignature,
  LAUNCH_REPORT_SIGNING_KEY_ID,
} from "./launch-report-signing"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }) as string
const PUB = publicKey.export({ type: "spki", format: "pem" }) as string

describe("launch report signing (tamper-evidence)", () => {
  it("signs and verifies a checksum", () => {
    const checksum = "a".repeat(64)
    const sig = signLaunchReportChecksum(checksum, PRIV)
    expect(verifyLaunchReportSignature(checksum, sig, PUB)).toBe(true)
  })

  it("rejects a tampered checksum", () => {
    const sig = signLaunchReportChecksum("a".repeat(64), PRIV)
    expect(verifyLaunchReportSignature("b".repeat(64), sig, PUB)).toBe(false)
  })

  it("rejects a tampered signature", () => {
    const checksum = "a".repeat(64)
    const sig = signLaunchReportChecksum(checksum, PRIV)
    expect(verifyLaunchReportSignature(checksum, sig.slice(0, -4) + "AAAA", PUB)).toBe(false)
  })

  it("fails closed on malformed signature input (no throw)", () => {
    expect(verifyLaunchReportSignature("a".repeat(64), "!!!not-base64!!!", PUB)).toBe(false)
  })

  it("rejects a non-ed25519 signing key", () => {
    expect(() => signLaunchReportChecksum("a".repeat(64), "not a pem")).toThrow()
  })

  it("names the published key id", () => {
    expect(LAUNCH_REPORT_SIGNING_KEY_ID).toMatch(/^lyrashield-launch-report-ed25519-/)
  })
})
