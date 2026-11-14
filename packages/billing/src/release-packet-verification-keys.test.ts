import { generateKeyPairSync } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ json: "", current: null as string | null }))
vi.mock("@lyrashield/config", () => ({
  env: {
    get RELEASE_PACKET_VERIFICATION_KEYS_JSON() {
      return state.json
    },
  },
}))
vi.mock("./launch-report-keys", () => ({
  resolveLaunchReportSigningPublicKey: async () => state.current,
}))
vi.mock("@lyrashield/db", async () => import("../../db/src/release-packet-signing"))

import { releasePacketSigningKeyId } from "@lyrashield/db"
import { resolveReleasePacketVerificationKeys } from "./release-packet-verification-keys"

function publicKey() {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
}

describe("release packet verification keyring", () => {
  beforeEach(() => {
    state.json = ""
    state.current = null
  })

  it("uses the existing managed public key when no keyring is configured", async () => {
    state.current = publicKey()
    expect(await resolveReleasePacketVerificationKeys()).toEqual([
      {
        id: releasePacketSigningKeyId(state.current),
        publicKey: state.current,
        revoked: false,
      },
    ])
  })

  it("treats explicit rotation and revocation records as authoritative", async () => {
    const oldKey = publicKey()
    state.current = publicKey()
    const records = [
      { id: releasePacketSigningKeyId(oldKey), publicKey: oldKey, revoked: true },
      { id: releasePacketSigningKeyId(state.current), publicKey: state.current, revoked: false },
    ]
    state.json = JSON.stringify(records)
    expect(await resolveReleasePacketVerificationKeys()).toEqual(records)
    state.json = "[]"
    expect(await resolveReleasePacketVerificationKeys()).toEqual([])
  })

  it("rejects duplicate, malformed, and incorrectly identified keys", async () => {
    const key = publicKey()
    const record = { id: releasePacketSigningKeyId(key), publicKey: key, revoked: false }
    for (const value of [
      JSON.stringify([record, record]),
      JSON.stringify([{ ...record, id: "wrong" }]),
      "not json",
    ]) {
      state.json = value
      await expect(resolveReleasePacketVerificationKeys()).rejects.toThrow()
    }
  })
})
