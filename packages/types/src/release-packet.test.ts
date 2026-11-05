import { describe, expect, it } from "vitest"
import {
  computeReleasePacketChecksum,
  releasePacketPayloadSchema,
  RELEASE_PACKET_VERSION,
} from "./release-packet"

const base = {
  version: RELEASE_PACKET_VERSION,
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
})
