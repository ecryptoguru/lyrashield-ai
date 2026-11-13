import assert from "node:assert/strict"
import { createPublicKey, verify } from "node:crypto"
import key from "./runtime-qualification-key.json" with { type: "json" }

export const runtimeQualificationKeyId = key.keyId
const digest = /^sha256:[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const numberId = /^[1-9][0-9]{0,19}$/
const maximumAge = 24 * 60 * 60 * 1000

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  assert.equal(Object.getPrototypeOf(value), Object.prototype)
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort())
}

export function verifyRuntimeQualificationSignature(raw: string, result: unknown): void {
  assert.equal(typeof raw, "string")
  assert.ok(Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 4096)
  exact(result, ["algorithm", "keyId", "signature"])
  assert.equal(result.algorithm, "RS256")
  assert.equal(result.keyId, runtimeQualificationKeyId)
  assert.equal(typeof result.signature, "string")
  assert.match(result.signature as string, /^[A-Za-z0-9+/]{512}$/)
  const signature = Buffer.from(result.signature as string, "base64")
  assert.equal(signature.toString("base64"), result.signature)
  const publicKey = createPublicKey({ key: key.publicKey, format: "jwk" })
  assert.equal(publicKey.asymmetricKeyDetails?.modulusLength, 3072)
  assert.ok(verify("RSA-SHA256", Buffer.from(raw), publicKey, signature))
}

export interface HeldSandboxPublicationRecord {
  schema: "lyrashield-held-sandbox-publication/1"
  purpose: "publication-evidence-only"
  qualified: false
  nativeInventoryRechecked: false
  runtimeAuthorityVerified: false
  signedBoundedCoverageVerified: true
  coveragePredicateChecksum: string
  publication: {
    sandboxDigest: string
    engineRevision: string
    publicationRevision: string
    publishRunId: string
    publishAttempt: string
  }
  nativeManifests: { amd64: string; arm64: string }
  issuer: { owner: string; source: string }
  issuedAt: string
  expiresAt: string
}

export function validateHeldSandboxPublicationRecord(
  value: unknown,
  expected: { sandboxImage: string; engineRevision: string },
  when = Date.now()
): asserts value is HeldSandboxPublicationRecord {
  exact(expected, ["sandboxImage", "engineRevision"])
  assert.ok(typeof expected.engineRevision === "string" && revision.test(expected.engineRevision))
  exact(value, [
    "schema",
    "purpose",
    "qualified",
    "nativeInventoryRechecked",
    "runtimeAuthorityVerified",
    "signedBoundedCoverageVerified",
    "coveragePredicateChecksum",
    "publication",
    "nativeManifests",
    "issuer",
    "issuedAt",
    "expiresAt",
  ])
  assert.equal(value.schema, "lyrashield-held-sandbox-publication/1")
  assert.equal(value.purpose, "publication-evidence-only")
  assert.equal(value.qualified, false)
  assert.equal(value.nativeInventoryRechecked, false)
  assert.equal(value.runtimeAuthorityVerified, false)
  assert.equal(value.signedBoundedCoverageVerified, true)
  assert.equal(typeof value.coveragePredicateChecksum, "string")
  assert.match(value.coveragePredicateChecksum as string, /^[a-f0-9]{64}$/)
  const publication = value.publication
  exact(publication, [
    "sandboxDigest",
    "engineRevision",
    "publicationRevision",
    "publishRunId",
    "publishAttempt",
  ])
  for (const field of ["engineRevision", "publicationRevision"])
    assert.ok(typeof publication[field] === "string" && revision.test(publication[field]))
  for (const field of ["publishRunId", "publishAttempt"])
    assert.ok(typeof publication[field] === "string" && numberId.test(publication[field]))
  assert.ok(typeof publication.sandboxDigest === "string" && digest.test(publication.sandboxDigest))
  assert.equal(
    expected.sandboxImage,
    "ghcr.io/ecryptoguru/lyrashield-sandbox@" + publication.sandboxDigest
  )
  assert.equal(expected.engineRevision, publication.engineRevision)
  exact(value.nativeManifests, ["amd64", "arm64"])
  for (const field of ["amd64", "arm64"])
    assert.ok(
      typeof value.nativeManifests[field] === "string" && digest.test(value.nativeManifests[field])
    )
  assert.notEqual(value.nativeManifests.amd64, value.nativeManifests.arm64)
  exact(value.issuer, ["owner", "source"])
  assert.ok(typeof value.issuer.source === "string" && revision.test(value.issuer.source))
  assert.ok(
    typeof value.issuer.owner === "string" &&
      /^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$/.test(value.issuer.owner)
  )
  assert.ok(Number.isSafeInteger(when) && when > 0)
  assert.equal(typeof value.issuedAt, "string")
  assert.equal(typeof value.expiresAt, "string")
  const issued = Date.parse(value.issuedAt as string),
    expires = Date.parse(value.expiresAt as string)
  assert.ok(Number.isFinite(issued) && Number.isFinite(expires))
  assert.equal(new Date(issued).toISOString(), value.issuedAt)
  assert.equal(new Date(expires).toISOString(), value.expiresAt)
  assert.ok(issued <= when && when < expires && expires > issued && expires - issued <= maximumAge)
}

export function verifyHeldSandboxPublicationRecord(
  envelope: unknown,
  expected: { sandboxImage: string; engineRevision: string },
  when = Date.now()
): HeldSandboxPublicationRecord {
  exact(envelope, ["raw", "result"])
  assert.equal(typeof envelope.raw, "string")
  verifyRuntimeQualificationSignature(envelope.raw as string, envelope.result)
  const record: unknown = JSON.parse(envelope.raw as string)
  validateHeldSandboxPublicationRecord(record, expected, when)
  Object.freeze(record.publication)
  Object.freeze(record.nativeManifests)
  Object.freeze(record.issuer)
  return Object.freeze(record)
}
