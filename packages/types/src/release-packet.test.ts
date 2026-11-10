import { describe, expect, it } from "vitest"
import {
  computeReleasePacketChecksum,
  LEGACY_RELEASE_PACKET_VERSION,
  releasePacketPayloadSchema,
  RELEASE_PACKET_VERSION,
} from "./release-packet"

const base = {
  version: LEGACY_RELEASE_PACKET_VERSION,
  generatedAt: "2026-11-05T00:00:00.000Z",
  target: { id: "target-1", name: "App", type: "REPO", environment: "PRODUCTION" },
  assessment: {
    verdictId: "verdict-1",
    standardVersion: "lyrashield-gate/2.4.0",
    state: "READY" as const,
    historicalState: "READY" as const,
    applicable: true,
    reasons: [],
    evaluatedAt: "2026-11-05T00:00:00.000Z",
    assessedIdentity: { kind: "COMMIT" as const, value: "a".repeat(40) },
    coverageStatement: ["sast"],
    nonCoverage: [],
  },
  signedAssessment: {
    state: "SIGNED" as const,
    reportId: "report-1",
    reportChecksum: "b".repeat(64),
    signature: "opaque-signature",
    signingKeyId: "lyrashield-launch-report-ed25519-1",
    verifiedAt: "2026-11-05T00:00:00.000Z",
  },
  remediation: {
    baselineScanId: "scan-0",
    currentScanId: "scan-1",
    counts: {
      newFindings: 1,
      recurringFindings: 1,
      resolvedFindings: 1,
      uncertainMatches: 1,
    },
    findings: [],
    truncated: false,
  },
  coverage: {
    completed: ["sast"],
    notApplicable: [],
    incomplete: [],
    manifestChecksum: "c".repeat(64),
  },
}

describe("release packet contract", () => {
  it("computes a deterministic checksum over canonical payload bytes", async () => {
    const checksum = await computeReleasePacketChecksum(base)
    const payload = { ...base, packetChecksum: checksum }
    expect(checksum).toMatch(/^[a-f0-9]{64}$/)
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base
    expect(await computeReleasePacketChecksum(reordered)).toBe(checksum)
    expect(releasePacketPayloadSchema.parse(payload)).toEqual(payload)
  })

  it("keeps signature uncertainty distinct from invalid or unsigned", async () => {
    for (const state of ["UNSIGNED", "UNAVAILABLE", "INVALID", "HISTORICAL"] as const) {
      const payload = {
        ...base,
        signedAssessment: { state, reason: "signature service unavailable" },
        packetChecksum: await computeReleasePacketChecksum(base),
      }
      expect(releasePacketPayloadSchema.parse(payload).signedAssessment.state).toBe(state)
    }
  })

  it("binds a version 1.1 packet's expiry and key identity without hashing its signature", async () => {
    const next = {
      ...base,
      version: RELEASE_PACKET_VERSION,
      expiresAt: "2026-11-06T00:00:00.000Z",
      signingKeyId: `lyrashield-packet-ed25519-${"d".repeat(64)}`,
    }
    const checksum = await computeReleasePacketChecksum(next)
    const signed = { ...next, packetChecksum: checksum, packetSignature: "s".repeat(88) }
    expect(releasePacketPayloadSchema.parse(signed)).toEqual(signed)
    expect(await computeReleasePacketChecksum({ ...signed, packetSignature: "t".repeat(88) })).toBe(
      checksum
    )
    expect(
      await computeReleasePacketChecksum({ ...next, expiresAt: "2026-11-05T12:00:00.000Z" })
    ).not.toBe(checksum)
    expect(
      await computeReleasePacketChecksum({
        ...next,
        signingKeyId: `lyrashield-packet-ed25519-${"e".repeat(64)}`,
      })
    ).not.toBe(checksum)
    expect(
      releasePacketPayloadSchema.safeParse({ ...next, packetChecksum: checksum }).success
    ).toBe(false)
    expect(
      releasePacketPayloadSchema.safeParse({
        ...signed,
        expiresAt: "2026-11-07T00:00:00.000Z",
      }).success
    ).toBe(false)
    expect(
      releasePacketPayloadSchema.safeParse({
        ...signed,
        signedAssessment: { ...signed.signedAssessment, expiresAt: "2026-11-05T12:00:00.000Z" },
      }).success
    ).toBe(false)
  })
})
