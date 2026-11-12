import assert from "node:assert/strict"
import test from "node:test"
import { verifyPreparedPair } from "../paired-prepared-candidate.mjs"

const candidate = {
  sourceSha: "a".repeat(40),
  engineRevision: "b".repeat(40),
  webDigest: "sha256:" + "c".repeat(64),
  workerDigest: "sha256:" + "d".repeat(64),
  proxyDigest: "sha256:" + "e".repeat(64),
  runId: "42",
  runAttempt: "2",
}
const pair = {
  productRevision: candidate.sourceSha,
  engineRevision: candidate.engineRevision,
  webDigest: candidate.webDigest,
  workerDigest: candidate.workerDigest,
  proxyDigest: candidate.proxyDigest,
}
const qualification = "f".repeat(64)

test("prebuilt digests must match the authenticated qualified release pair", async () => {
  let calls = 0
  const preflight = async (digest) => {
    calls++
    assert.equal(digest, qualification)
    return { source: candidate.sourceSha, pair }
  }
  await verifyPreparedPair(candidate, qualification, { preflight })
  assert.equal(calls, 1)
  for (const key of ["sourceSha", "engineRevision", "workerDigest", "webDigest", "proxyDigest"]) {
    const value = candidate[key]
    const changed = {
      ...candidate,
      [key]:
        (value.startsWith("sha256:") ? "sha256:" : "") +
        "9".repeat(value.startsWith("sha256:") ? 64 : 40),
    }
    await assert.rejects(verifyPreparedPair(changed, qualification, { preflight }))
  }
  await assert.rejects(
    verifyPreparedPair({ ...candidate, runAttempt: "0" }, qualification, { preflight })
  )
  await assert.rejects(
    verifyPreparedPair(candidate, qualification, {
      preflight: async () => {
        throw Error("authority unavailable")
      },
    })
  )
})
