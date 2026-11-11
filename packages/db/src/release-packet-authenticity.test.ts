import { generateKeyPairSync } from "node:crypto"
import {
  computeReleasePacketChecksum,
  LEGACY_RELEASE_PACKET_VERSION,
  RELEASE_PACKET_VERSION,
  type ReleasePacketPayload,
} from "@lyrashield/types"
import { describe, expect, it } from "vitest"
import { LAUNCH_REPORT_SIGNING_KEY_ID, signLaunchReportChecksum } from "./launch-report-signing"
import {
  evaluateAssessmentValidity,
  evaluatePacketAuthenticity,
} from "./release-packet-authenticity"
import { releasePacketSigningKeyId, signReleasePacketChecksum } from "./release-packet-signing"

const pair = generateKeyPairSync("ed25519")
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
const keyId = releasePacketSigningKeyId(publicKey)
const keys = [{ id: keyId, publicKey, revoked: false }]
const now = new Date("2026-11-06T00:00:00.000Z")

async function packet(): Promise<ReleasePacketPayload> {
  const base = {
    version: RELEASE_PACKET_VERSION,
    signingKeyId: keyId,
    generatedAt: now.toISOString(),
    expiresAt: "2026-11-06T06:00:00.000Z",
    target: { id: "target", name: "App", type: "REPO", environment: null },
    assessment: {
      verdictId: "verdict",
      standardVersion: "v1",
      state: "READY" as const,
      historicalState: "READY" as const,
      applicable: true,
      reasons: [],
      evaluatedAt: now.toISOString(),
      assessedIdentity: null,
      coverageStatement: [],
      nonCoverage: [],
    },
    signedAssessment: {
      state: "SIGNED" as const,
      reportChecksum: "b".repeat(64),
      signature: signLaunchReportChecksum("b".repeat(64), privateKey),
      signingKeyId: LAUNCH_REPORT_SIGNING_KEY_ID,
      expiresAt: "2026-11-06T06:00:00.000Z",
    },
    remediation: {
      baselineScanId: null,
      currentScanId: "scan",
      counts: { newFindings: 0, recurringFindings: 0, resolvedFindings: 0, uncertainMatches: 0 },
      findings: [],
      truncated: false,
    },
    coverage: { completed: [], notApplicable: [], incomplete: [], manifestChecksum: null },
  }
  const packetChecksum = await computeReleasePacketChecksum(base)
  return {
    ...base,
    packetChecksum,
    packetSignature: signReleasePacketChecksum(packetChecksum, privateKey),
  }
}

describe("release packet read-time validity", () => {
  it("separates packet authentication, packet expiry, and assessment expiry", async () => {
    const value = await packet()
    expect(await evaluatePacketAuthenticity(value, keys, now)).toMatchObject({
      signatureState: "VERIFIED",
      expired: false,
    })
    expect(evaluateAssessmentValidity(value, publicKey, keys, now)).toMatchObject({
      signatureState: "VERIFIED",
      expired: false,
    })
    const later = new Date("2026-11-06T07:00:00.000Z")
    expect((await evaluatePacketAuthenticity(value, keys, later)).expired).toBe(true)
    expect(evaluateAssessmentValidity(value, publicKey, keys, later).expired).toBe(true)
    expect(
      (await evaluatePacketAuthenticity(value, keys, new Date("2026-11-06T06:00:00.000Z"))).expired
    ).toBe(true)
  })

  it("does not validate an assessment signed by a revoked or unlisted shared key", async () => {
    const value = await packet()
    const newPair = generateKeyPairSync("ed25519")
    const newPrivate = newPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const newPublic = newPair.publicKey.export({ type: "spki", format: "pem" }).toString()
    const newId = releasePacketSigningKeyId(newPublic)
    value.signingKeyId = newId
    value.packetChecksum = await computeReleasePacketChecksum(value)
    value.packetSignature = signReleasePacketChecksum(value.packetChecksum, newPrivate)
    const rotated = [
      { ...keys[0]!, revoked: true },
      { id: newId, publicKey: newPublic, revoked: false },
    ]
    expect((await evaluatePacketAuthenticity(value, rotated, now)).signatureState).toBe("VERIFIED")
    expect(evaluateAssessmentValidity(value, publicKey, rotated, now).signatureState).toBe(
      "REVOKED"
    )
    expect(evaluateAssessmentValidity(value, publicKey, [rotated[1]!], now).signatureState).toBe(
      "UNAVAILABLE"
    )
  })

  it("reports revocation, missing keys, altered contents, and historical unsigned packets", async () => {
    const value = await packet()
    expect(
      (await evaluatePacketAuthenticity(value, [{ ...keys[0]!, revoked: true }], now))
        .signatureState
    ).toBe("REVOKED")
    expect((await evaluatePacketAuthenticity(value, [], now)).signatureState).toBe("UNAVAILABLE")
    expect(
      (await evaluatePacketAuthenticity({ ...value, packetSignature: "bad" }, keys, now))
        .signatureState
    ).toBe("INVALID")
    const changed = { ...value, target: { ...value.target, name: "Changed" } }
    expect((await evaluatePacketAuthenticity(changed, keys, now)).signatureState).toBe("INVALID")
    changed.packetChecksum = await computeReleasePacketChecksum(changed)
    expect((await evaluatePacketAuthenticity(changed, keys, now)).signatureState).toBe("INVALID")
    const historical: ReleasePacketPayload = { ...value, version: LEGACY_RELEASE_PACKET_VERSION }
    delete historical.expiresAt
    delete historical.signingKeyId
    delete historical.packetSignature
    historical.packetChecksum = await computeReleasePacketChecksum(historical)
    expect((await evaluatePacketAuthenticity(historical, keys, now)).signatureState).toBe(
      "HISTORICAL_UNSIGNED"
    )
  })
})
