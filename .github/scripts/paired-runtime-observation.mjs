// The trusted VM observer verifies the installed managed signature and real state.
import assert from "node:assert/strict"
import { guest } from "./paired-live-transport.mjs"

const digest = /^sha256:[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/

export function verifyInstalledRuntimeAuthority(context, read = guest) {
  const expected = {
    productRevision: context?.source,
    engineRevision: context?.pair?.engineRevision,
    workerDigest: context?.pair?.workerDigest,
    sandboxDigest: context?.pair?.sandboxDigest,
    brokerDigest: context?.controlPlane?.brokerDigest,
    supervisorDigest: context?.controlPlane?.supervisorDigest,
    providerGatewayDigest: context?.controlPlane?.providerGatewayDigest,
    migrationChecksum: context?.controlPlane?.migrationChecksum,
    runtimePolicyDigest: context?.controlPlane?.runtimePolicyDigest,
  }
  for (const [field, value] of Object.entries(expected))
    assert.ok(
      typeof value === "string" && (field.endsWith("Revision") ? revision : digest).test(value)
    )
  const observed = read("runtime-authority", expected)
  assert.ok(observed && Object.getPrototypeOf(observed) === Object.prototype)
  assert.deepEqual(Object.keys(observed).sort(), [
    "authorityDigest",
    "epoch",
    "epochId",
    "identitiesDigest",
    "runtimePolicyDigest",
    "sandboxImageId",
    "schema",
  ])
  assert.equal(observed.schema, "lyrashield-installed-runtime-observation/1")
  assert.equal(observed.runtimePolicyDigest, expected.runtimePolicyDigest)
  assert.ok(
    typeof observed.epochId === "string" &&
      id.test(observed.epochId) &&
      !observed.epochId.includes("..")
  )
  assert.ok(
    Number.isSafeInteger(observed.epoch) && observed.epoch > 0 && observed.epoch <= 2147483647
  )
  for (const field of ["authorityDigest", "identitiesDigest", "sandboxImageId"])
    assert.ok(typeof observed[field] === "string" && digest.test(observed[field]))
  return true
}
