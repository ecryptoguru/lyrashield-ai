import { generateKeyPairSync, sign } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "@lyrashield/runtime-control"
import { createSandboxToolCapabilityVerifier } from "./sandbox-tool-capability"

const key = generateKeyPairSync("rsa", { modulusLength: 3072 })
const publicKeyPem = key.publicKey.export({ type: "spki", format: "pem" }).toString()
const now = Date.parse("2026-11-14T00:00:00Z")
const scope = {
  schema: "lyrashield-sandbox-tool-capability/1",
  authorityEpochId: "epoch-1",
  operationId: "operation-1",
  attemptId: "attempt-1",
  scanId: "scan-1",
  workspaceId: "workspace-1",
  authorityRevision: 1,
  prepareCommandId: "prepare-1",
  prepareCommandInputChecksum: "a".repeat(64),
  authorityChecksum: "b".repeat(64),
  ownershipReceiptId: "receipt-1",
  ownership: {
    kind: "container",
    executorKey: "sandbox",
    ownershipId: `own_${"c".repeat(40)}`,
    containerId: "d".repeat(64),
  },
  sandboxHandle: `own_${"c".repeat(40)}`,
  issuedAt: "2026-11-14T00:00:00.000Z",
  expiresAt: "2026-11-14T00:15:00.000Z",
}
const expected = { attemptId: scope.attemptId, sandboxHandle: scope.sandboxHandle }
function token(
  payload: unknown = scope,
  header: unknown = { alg: "RS256", kid: "key-1", typ: "JWT" }
) {
  const input = `${Buffer.from(canonicalJson(header)).toString("base64url")}.${Buffer.from(canonicalJson(payload)).toString("base64url")}`
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`
}
const verify = createSandboxToolCapabilityVerifier({
  publicKeyPem,
  keyId: "key-1",
  authorityEpochId: scope.authorityEpochId,
  now: () => now,
})

describe("sandbox scoped capability", () => {
  it("rejects private signing material and oversized or extra PEM inputs", () => {
    const options = { keyId: "key-1", authorityEpochId: scope.authorityEpochId }
    expect(() =>
      createSandboxToolCapabilityVerifier({
        ...options,
        publicKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      })
    ).toThrow("public key")
    expect(() =>
      createSandboxToolCapabilityVerifier({ ...options, publicKeyPem: publicKeyPem + publicKeyPem })
    ).toThrow()
    expect(() =>
      createSandboxToolCapabilityVerifier({ ...options, publicKeyPem: "x".repeat(4097) })
    ).toThrow()
  })
  it("accepts a delegated signature only for its exact epoch/attempt/owned sandbox", () => {
    expect(token().length).toBeLessThanOrEqual(2048)
    expect(verify(token(), expected)).toEqual(scope)
  })
  it("rejects another attempt, handle, epoch or signer", () => {
    expect(() => verify(token(), { ...expected, attemptId: "foreign-1" })).toThrow()
    expect(() => verify(token(), { ...expected, sandboxHandle: "foreign-1" })).toThrow()
    expect(() => verify(token({ ...scope, authorityEpochId: "foreign-1" }), expected)).toThrow()
    expect(() =>
      verify(token(scope, { alg: "RS256", kid: "foreign-1", typ: "JWT" }), expected)
    ).toThrow()
  })
  it("rejects signature tampering, algorithm confusion and broader scope", () => {
    const valid = token(),
      parts = valid.split(".")
    parts[1] = Buffer.from(canonicalJson({ ...scope, attemptId: "foreign-1" })).toString(
      "base64url"
    )
    expect(() => verify(parts.join("."), expected)).toThrow()
    expect(() =>
      verify(token(scope, { alg: "HS256", kid: "key-1", typ: "JWT" }), expected)
    ).toThrow()
    expect(() => verify(token({ ...scope, administrator: true }), expected)).toThrow()
  })
  it("expires physical invocation while retaining exact authenticated observation", () => {
    const expired = token({
      ...scope,
      issuedAt: "2026-11-13T23:45:00.000Z",
      expiresAt: scope.issuedAt,
    })
    expect(() => verify(expired, expected)).toThrow()
    expect(verify(expired, expected, "observe").attemptId).toBe(scope.attemptId)
    expect(() =>
      verify(token({ ...scope, expiresAt: "2026-11-14T00:45:00.001Z" }), expected)
    ).toThrow()
  })
  it("supports the accepted long REPO runtime without treating the signature as cached current permission", () => {
    const long = token({ ...scope, expiresAt: "2026-11-14T00:45:00.000Z" })
    const later = createSandboxToolCapabilityVerifier({
      publicKeyPem,
      keyId: "key-1",
      authorityEpochId: scope.authorityEpochId,
      now: () => now + 16 * 60_000,
    })
    expect(later(long, expected).expiresAt).toBe("2026-11-14T00:45:00.000Z")
    // Intent publication still validates the current stored account, epoch, grant and deadline before native execution.
    expect(() => later(token(), expected)).toThrow()
  })
})
