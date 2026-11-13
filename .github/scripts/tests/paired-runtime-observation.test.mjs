import assert from "node:assert/strict"
import test from "node:test"
import { verifyInstalledRuntimeAuthority } from "../paired-runtime-observation.mjs"

const digest = "sha256:" + "a".repeat(64)
const context = {
  source: "b".repeat(40),
  pair: { engineRevision: "c".repeat(40), workerDigest: digest, sandboxDigest: digest },
  controlPlane: {
    brokerDigest: digest,
    supervisorDigest: digest,
    providerGatewayDigest: digest,
    migrationChecksum: digest,
    runtimePolicyDigest: digest,
  },
}
const observation = {
  schema: "lyrashield-installed-runtime-observation/1",
  authorityDigest: digest,
  runtimePolicyDigest: digest,
  epochId: "epoch-2",
  epoch: 2,
  identitiesDigest: digest,
  sandboxImageId: digest,
}

test("authority verifier binds the protected observer to the exact qualified tuple", () => {
  assert.equal(
    verifyInstalledRuntimeAuthority(context, (phase, expected) => {
      assert.equal(phase, "runtime-authority")
      assert.deepEqual(expected, {
        productRevision: context.source,
        ...context.pair,
        ...context.controlPlane,
      })
      return observation
    }),
    true
  )
})

test("unavailable installed evidence, changed policy, malformed epoch and booleans remain closed", () => {
  for (const value of [
    true,
    null,
    {},
    { ...observation, runtimePolicyDigest: "sha256:" + "d".repeat(64) },
    { ...observation, epoch: 0 },
    { ...observation, epochId: "../epoch" },
    { ...observation, qualified: true },
  ])
    assert.throws(() => verifyInstalledRuntimeAuthority(context, () => value))
  assert.throws(() =>
    verifyInstalledRuntimeAuthority(context, () => {
      throw new Error("missing installed envelope")
    })
  )
  let invoked = false
  assert.throws(() =>
    verifyInstalledRuntimeAuthority({}, () => {
      invoked = true
    })
  )
  assert.equal(invoked, false)
})
