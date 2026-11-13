import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  releasePacketSigningKeyId,
  signReleasePacketChecksum,
  verifyReleasePacketChecksum,
} from "./release-packet-signing"

function keyPair() {
  const keys = generateKeyPairSync("ed25519")
  return {
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
}

describe("release packet signing keys", () => {
  it("binds the checksum and identifies the actual public key", () => {
    const key = keyPair()
    const checksum = "a".repeat(64)
    const id = releasePacketSigningKeyId(key.publicKey)
    const signature = signReleasePacketChecksum(checksum, key.privateKey)
    const keys = [{ id, publicKey: key.publicKey, revoked: false }]
    expect(verifyReleasePacketChecksum(checksum, signature, id, keys)).toBe("VERIFIED")
    expect(verifyReleasePacketChecksum("b".repeat(64), signature, id, keys)).toBe("INVALID")
  })

  it("keeps retired keys verifiable, rejects revoked keys, and fails closed for unknown keys", () => {
    const oldKey = keyPair()
    const newKey = keyPair()
    const oldId = releasePacketSigningKeyId(oldKey.publicKey)
    const newId = releasePacketSigningKeyId(newKey.publicKey)
    const signature = signReleasePacketChecksum("a".repeat(64), oldKey.privateKey)
    const keys = [
      { id: oldId, publicKey: oldKey.publicKey, revoked: false },
      { id: newId, publicKey: newKey.publicKey, revoked: false },
    ]
    expect(verifyReleasePacketChecksum("a".repeat(64), signature, oldId, keys)).toBe("VERIFIED")
    expect(verifyReleasePacketChecksum("a".repeat(64), signature, oldId, [keys[1]!])).toBe(
      "UNAVAILABLE"
    )
    expect(
      verifyReleasePacketChecksum("a".repeat(64), signature, oldId, [
        { ...keys[0]!, revoked: true },
      ])
    ).toBe("REVOKED")
    expect(
      verifyReleasePacketChecksum("a".repeat(64), signature, oldId, [
        { id: oldId, publicKey: newKey.publicKey, revoked: false },
      ])
    ).toBe("INVALID")
  })
})
