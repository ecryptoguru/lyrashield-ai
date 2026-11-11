import assert from "node:assert/strict"
import test from "node:test"
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto"
import { issueHeldSandboxPublication } from "../issue-sandbox-publication.mjs"
import { runtimeQualificationKeyId } from "../../../packages/security/src/sandbox-publication-record.ts"

const when = Date.parse("2026-11-12T00:00:00.000Z")
const selector = {
  engineRevision: "a".repeat(40),
  publicationRevision: "b".repeat(40),
  publishRunId: "42",
  publishAttempt: "1",
  sandboxDigest: "sha256:" + "c".repeat(64),
}
const publication = {
  ...selector,
  qualified: false,
  nativeInventoryRechecked: false,
  signedBoundedCoverageVerified: true,
  coveragePredicateChecksum: "d".repeat(64),
  nativeManifests: { amd64: "sha256:" + "e".repeat(64), arm64: "sha256:" + "f".repeat(64) },
}
const identity = {
  token: "synthetic-test-token",
  identity: { owner: "99:2", source: "1".repeat(40) },
}
const readIdentity = async () => identity
const verifyPublication = async (value) => {
  assert.deepEqual(value, selector)
  return structuredClone(publication)
}

test("issuer authenticates and verifies before any credential exchange", async () => {
  for (const failure of ["identity", "publication", "qualified", "manifest"]) {
    const calls = []
    await assert.rejects(
      issueHeldSandboxPublication(JSON.stringify(selector), {
        when,
        readIdentity:
          failure === "identity"
            ? async () => {
                throw Error("unavailable")
              }
            : readIdentity,
        verifyPublication: async () => {
          if (failure === "publication") throw Error("unavailable")
          return {
            ...publication,
            ...(failure === "qualified" ? { qualified: true } : {}),
            ...(failure === "manifest" ? { nativeManifests: { amd64: "x", arm64: "y" } } : {}),
          }
        },
        run: (args) => calls.push(args),
      })
    )
    assert.deepEqual(calls, [])
  }
})

test("signs only the internally constructed held record and verifies exact returned signature", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 })
  const calls = []
  let signedRaw
  const receipt = await issueHeldSandboxPublication(JSON.stringify(selector), {
    when,
    readIdentity,
    verifyPublication,
    run: (args) => {
      calls.push(args)
      if (args[0] !== "keyvault") return null
      // Sign the independently constructed expected record, not caller bytes.
      signedRaw = JSON.stringify({
        schema: "lyrashield-held-sandbox-publication/1",
        purpose: "publication-evidence-only",
        qualified: false,
        nativeInventoryRechecked: false,
        runtimeAuthorityVerified: false,
        signedBoundedCoverageVerified: true,
        coveragePredicateChecksum: publication.coveragePredicateChecksum,
        publication: {
          sandboxDigest: selector.sandboxDigest,
          engineRevision: selector.engineRevision,
          publicationRevision: selector.publicationRevision,
          publishRunId: selector.publishRunId,
          publishAttempt: selector.publishAttempt,
        },
        nativeManifests: publication.nativeManifests,
        issuer: { owner: identity.identity.owner, source: identity.identity.source },
        issuedAt: new Date(when).toISOString(),
        expiresAt: new Date(when + 86400000).toISOString(),
      })
      assert.equal(
        args[args.indexOf("--digest") + 1],
        createHash("sha256").update(signedRaw).digest("base64")
      )
      assert.equal(args[args.indexOf("--id") + 1], runtimeQualificationKeyId)
      assert.equal(args[args.indexOf("--algorithm") + 1], "RS256")
      return {
        algorithm: "RS256",
        keyId: runtimeQualificationKeyId,
        signature: sign("RSA-SHA256", Buffer.from(signedRaw), keys.privateKey).toString("base64"),
      }
    },
    verifySignature: (raw, result) => {
      assert.equal(raw, signedRaw)
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(raw),
          keys.publicKey,
          Buffer.from(result.signature, "base64")
        )
      )
    },
  })
  assert.equal(receipt.raw, signedRaw)
  assert.ok(Object.isFrozen(receipt))
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["login", "keyvault", "logout"]
  )
  const record = JSON.parse(receipt.raw)
  assert.equal(record.qualified, false)
  assert.equal(record.runtimeAuthorityVerified, false)
  assert.notEqual(receipt.raw, JSON.stringify(selector))
})

test("login, signing and fixed-key verification failures always log out and issue nothing", async () => {
  for (const failure of ["login", "keyvault", "signature"]) {
    const calls = []
    await assert.rejects(
      issueHeldSandboxPublication(JSON.stringify(selector), {
        when,
        readIdentity,
        verifyPublication,
        run: (args) => {
          calls.push(args)
          if (args[0] === failure) throw Error("unavailable")
          return args[0] === "keyvault"
            ? { algorithm: "RS256", keyId: runtimeQualificationKeyId, signature: "A".repeat(512) }
            : null
        },
      })
    )
    assert.deepEqual(calls.at(-1), ["logout"])
  }
})
