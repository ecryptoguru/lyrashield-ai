import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "@lyrashield/runtime-control"
import {
  RootSandboxGrantSigner,
  verifyRootSandboxGrantDelegation,
  sandboxToolAcceptanceSchema,
} from "./root-sandbox-grant"

const root = generateKeyPairSync("rsa", { modulusLength: 3072 }),
  delegated = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicDer = delegated.publicKey.export({ format: "der", type: "spki" })
const pin = {
  algorithm: "RS256",
  keyId: "https://fixture.invalid/keys/root/fixture-version",
  publicKey: root.publicKey.export({ format: "jwk" }),
}
const source = "a".repeat(40)
const authority = {
  schema: "lyrashield-installed-runtime-authority/1",
  purpose: "launch-qualified-controller",
  productRevision: source,
  engineRevision: "b".repeat(40),
  epochId: "fixture-epoch",
  epoch: 1,
  issuedAt: Math.floor(Date.now() / 1000) - 10,
  sandboxDigest: "sha256:" + "c".repeat(64),
  runtimePolicyDigest: "sha256:" + "d".repeat(64),
  acceptanceDigest: "sha256:" + "e".repeat(64),
  toolChannel: {
    schema: "lyrashield-sandbox-tool-channel/1",
    origin: "https://tools.fixture.invalid",
  },
  sandboxGrantSigner: {
    schema: "lyrashield-sandbox-grant-signer/1",
    purpose: "sandbox-tool-grants",
    algorithm: "RS256",
    keyId: "fixture-delegated",
    epochId: "fixture-epoch",
    epoch: 1,
    publicKey: delegated.publicKey.export({ format: "jwk" }),
    publicKeySha256: "sha256:" + createHash("sha256").update(publicDer).digest("hex"),
  },
}
function envelope(value: unknown) {
  const raw = canonicalJson(value)
  return {
    raw,
    result: {
      algorithm: "RS256",
      keyId: pin.keyId,
      signature: sign("RSA-SHA256", Buffer.from(raw), root.privateKey).toString("base64"),
    },
  }
}
const privateKey = delegated.privateKey.export({ format: "pem", type: "pkcs8" }) as string
function checked(value = authority, overrides = {}) {
  return verifyRootSandboxGrantDelegation({
    pin,
    envelope: envelope(value),
    privateKey: Buffer.from(privateKey),
    source,
    ...overrides,
  })
}
describe("root sandbox signing delegation", () => {
  it("accepts a real independent root signature and the matching delegated RSA key", () => {
    const result = checked()
    expect(result.authority.productRevision).toBe(source)
    expect(createPublicKey(result.key).export({ format: "der", type: "spki" })).toEqual(publicDer)
  })
  it("rejects another private key and the root key as a delegated signer", () => {
    expect(() =>
      checked(authority, {
        privateKey: Buffer.from(root.privateKey.export({ format: "pem", type: "pkcs8" }) as string),
      })
    ).toThrow()
  })
  it("rejects a different source or root signing pin", () => {
    expect(() => checked(authority, { source: "f".repeat(40) })).toThrow()
    expect(() =>
      checked(authority, {
        pin: { ...pin, publicKey: delegated.publicKey.export({ format: "jwk" }) },
      })
    ).toThrow()
  })
  it("rejects mismatched epoch, key digest, future issue and disposable purpose", () => {
    for (const value of [
      {
        ...authority,
        sandboxGrantSigner: { ...authority.sandboxGrantSigner, epochId: "other-epoch" },
      },
      {
        ...authority,
        sandboxGrantSigner: {
          ...authority.sandboxGrantSigner,
          publicKeySha256: "sha256:" + "f".repeat(64),
        },
      },
      { ...authority, issuedAt: Math.floor(Date.now() / 1000) + 60 },
      { ...authority, purpose: "disposable-linux-native-tests" },
    ])
      expect(() => checked(value as typeof authority)).toThrow()
  })
  it("rejects altered signed bytes and noncanonical JSON", () => {
    const signed = envelope(authority)
    expect(() =>
      checked(authority, {
        envelope: { ...signed, raw: signed.raw.replace(source, "f".repeat(40)) },
      })
    ).toThrow()
    const raw = JSON.stringify(authority)
    expect(() =>
      checked(authority, {
        envelope: {
          raw,
          result: {
            ...signed.result,
            signature: sign("RSA-SHA256", Buffer.from(raw), root.privateKey).toString("base64"),
          },
        },
      })
    ).toThrow()
  })
  it("denies production root loading from the ordinary nonroot workspace", () => {
    if (process.getuid?.() !== 0 || process.platform !== "linux")
      expect(() => RootSandboxGrantSigner.load(source)).toThrow()
  })
  it("acceptance never accepts empty or unsupported capability evidence", () => {
    const base = {
      schema: "lyrashield-sandbox-tool-acceptance/1",
      productRevision: source,
      engineRevision: authority.engineRevision,
      sandboxDigest: authority.sandboxDigest,
      runtimePolicyDigest: authority.runtimePolicyDigest,
    }
    expect(
      sandboxToolAcceptanceSchema.safeParse({
        ...base,
        capabilities: { exec: { status: "supported", detail: "fixture", evidence: {} } },
      }).success
    ).toBe(false)
    expect(
      sandboxToolAcceptanceSchema.safeParse({
        ...base,
        capabilities: {
          exec: { status: "unsupported", detail: "fixture", evidence: { receipt: "a" } },
        },
      }).success
    ).toBe(false)
  })
})
