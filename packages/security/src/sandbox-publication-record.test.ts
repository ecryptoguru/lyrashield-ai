import { describe, expect, it, vi } from "vitest"
import { sign } from "node:crypto"

const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto")
  return generateKeyPairSync("rsa", { modulusLength: 3072 })
})
// Only the test module supplies a synthetic key; production has no key input.
vi.mock("./runtime-qualification-key.json", async (importOriginal) => {
  const original = await importOriginal<{ default: { keyId: string } }>()
  return { default: { ...original.default, publicKey: keys.publicKey.export({ format: "jwk" }) } }
})
import {
  runtimeQualificationKeyId,
  validateHeldSandboxPublicationRecord,
  verifyHeldSandboxPublicationRecord,
} from "./sandbox-publication-record"

const when = Date.parse("2026-11-12T00:00:00.000Z")
const record = {
  schema: "lyrashield-held-sandbox-publication/1",
  purpose: "publication-evidence-only",
  qualified: false,
  nativeInventoryRechecked: false,
  runtimeAuthorityVerified: false,
  signedBoundedCoverageVerified: true,
  coveragePredicateChecksum: "d".repeat(64),
  publication: {
    sandboxDigest: "sha256:" + "c".repeat(64),
    engineRevision: "a".repeat(40),
    publicationRevision: "b".repeat(40),
    publishRunId: "42",
    publishAttempt: "1",
  },
  nativeManifests: { amd64: "sha256:" + "e".repeat(64), arm64: "sha256:" + "f".repeat(64) },
  issuer: { owner: "99:2", source: "1".repeat(40) },
  issuedAt: new Date(when).toISOString(),
  expiresAt: new Date(when + 86400000).toISOString(),
}
const expected = {
  sandboxImage: "ghcr.io/ecryptoguru/lyrashield-sandbox@" + record.publication.sandboxDigest,
  engineRevision: record.publication.engineRevision,
}
const envelope = (value: unknown = record) => {
  const raw = JSON.stringify(value)
  return {
    raw,
    result: {
      algorithm: "RS256",
      keyId: runtimeQualificationKeyId,
      signature: sign("RSA-SHA256", Buffer.from(raw), keys.privateKey).toString("base64"),
    },
  }
}

describe("managed-signed sandbox publication record", () => {
  it("verifies exact bytes and freezes a held record bound to the running image and engine", () => {
    const result = verifyHeldSandboxPublicationRecord(envelope(), expected, when)
    expect(result.qualified).toBe(false)
    expect(result.runtimeAuthorityVerified).toBe(false)
    for (const value of [result, result.publication, result.nativeManifests, result.issuer])
      expect(Object.isFrozen(value)).toBe(true)
  })
  it("rejects byte, signature, key, algorithm and extra-envelope changes", () => {
    const valid = envelope()
    for (const altered of [
      { ...valid, raw: valid.raw + " " },
      { ...valid, extra: true },
      ...["signature", "keyId", "algorithm"].map((field) => ({
        ...valid,
        result: { ...valid.result, [field]: "foreign" },
      })),
    ])
      expect(() => verifyHeldSandboxPublicationRecord(altered, expected, when)).toThrow()
  })
  it("rejects signatures from a different key with the same declared key ID", async () => {
    const { generateKeyPairSync } = await import("node:crypto")
    const foreign = generateKeyPairSync("rsa", { modulusLength: 3072 })
    const value = envelope()
    value.result.signature = sign(
      "RSA-SHA256",
      Buffer.from(value.raw),
      foreign.privateKey
    ).toString("base64")
    expect(() => verifyHeldSandboxPublicationRecord(value, expected, when)).toThrow()
  })
  it.each(["qualified", "nativeInventoryRechecked", "runtimeAuthorityVerified"])(
    "rejects even a signed %s admission upgrade",
    (field) => {
      expect(() =>
        verifyHeldSandboxPublicationRecord(envelope({ ...record, [field]: true }), expected, when)
      ).toThrow()
    }
  )
  it("rejects signed unknown fields and health records", () => {
    for (const altered of [
      { ...record, unknown: true },
      { ...record, schema: "lyrashield-qualification-key-health/1" },
      { ...record, publication: { ...record.publication, unknown: true } },
    ])
      expect(() => verifyHeldSandboxPublicationRecord(envelope(altered), expected, when)).toThrow()
  })
  it("rejects another image, engine, duplicate native manifest, future issue and expired or overlong record", () => {
    expect(() =>
      verifyHeldSandboxPublicationRecord(
        envelope(),
        { ...expected, engineRevision: "2".repeat(40) },
        when
      )
    ).toThrow()
    expect(() =>
      verifyHeldSandboxPublicationRecord(
        envelope(),
        { ...expected, sandboxImage: expected.sandboxImage + "x" },
        when
      )
    ).toThrow()
    for (const altered of [
      {
        ...record,
        nativeManifests: {
          amd64: record.nativeManifests.amd64,
          arm64: record.nativeManifests.amd64,
        },
      },
      { ...record, issuedAt: new Date(when + 1).toISOString() },
      { ...record, expiresAt: new Date(when).toISOString() },
      { ...record, expiresAt: new Date(when + 86400001).toISOString() },
    ])
      expect(() => verifyHeldSandboxPublicationRecord(envelope(altered), expected, when)).toThrow()
    expect(() => validateHeldSandboxPublicationRecord(record, expected, when + 86400000)).toThrow()
  })
})
