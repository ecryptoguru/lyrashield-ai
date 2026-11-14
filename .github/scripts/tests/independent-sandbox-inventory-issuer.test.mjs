import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { issueHeldInventoryEvidence } from "../issue-sandbox-inventory.mjs"

const when = Date.parse("2026-11-12T00:00:00.000Z")
const selector = {
  engineRevision: "a".repeat(40),
  publicationRevision: "b".repeat(40),
  publishRunId: "42",
  publishAttempt: "1",
  sandboxDigest: "sha256:" + "c".repeat(64),
  verifierRevision: "d".repeat(40),
  verifierRunId: "52",
  verifierAttempt: "2",
}
const verified = {
  ...selector,
  qualified: false,
  nativeInventoryRechecked: true,
  runtimeAuthorityVerified: false,
  coveragePredicateChecksum: "1".repeat(64),
  inventoryPredicateChecksum: "2".repeat(64),
  nativeManifests: { amd64: "sha256:" + "3".repeat(64), arm64: "sha256:" + "4".repeat(64) },
}
const identity = { token: "test", identity: { owner: "99:2", source: "5".repeat(40) } }

test("issuer verifies protected inventory before any credentials and signs only held evidence", async () => {
  const calls = [],
    events = []
  let digest
  const result = await issueHeldInventoryEvidence(JSON.stringify(selector), {
    when,
    readIdentity: async () => {
      events.push("identity")
      return identity
    },
    verifyInventory: (value) => {
      events.push("inventory")
      assert.deepEqual(value, selector)
      return verified
    },
    run: (args) => {
      calls.push(args)
      events.push(args[0])
      if (args[0] === "keyvault") digest = args[args.indexOf("--digest") + 1]
      return args[0] === "keyvault" ? { signature: "fixture" } : null
    },
    verifySignature: (raw) => {
      events.push("signature")
      assert.equal(createHash("sha256").update(raw).digest("base64"), digest)
    },
  })
  const record = JSON.parse(result.raw)
  assert.deepEqual(events, ["identity", "inventory", "login", "keyvault", "signature", "logout"])
  assert.equal(record.qualified, false)
  assert.equal(record.nativeInventoryRechecked, true)
  assert.equal(record.runtimeAuthorityVerified, false)
  assert.equal(record.purpose, "bounded-inventory-evidence-only")
  assert.equal(record.inventoryPredicateChecksum, verified.inventoryPredicateChecksum)
  assert.equal(calls.at(-1)[0], "logout")
})

test("failed or upgraded evidence cannot reach managed signing", async () => {
  for (const verifyInventory of [
    () => {
      throw Error("bad evidence")
    },
    () => ({ ...verified, runtimeAuthorityVerified: true }),
    () => ({ ...verified, qualified: true }),
  ]) {
    const calls = []
    await assert.rejects(
      issueHeldInventoryEvidence(JSON.stringify(selector), {
        when,
        readIdentity: async () => identity,
        verifyInventory,
        run: (args) => calls.push(args),
      })
    )
    assert.deepEqual(calls, [])
  }
})
