// Preflight comparison only; it never builds or changes a runtime.
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { preflightQualifiedRelease } from "./paired-runtime-workflow.mjs"

export async function verifyPreparedPair(
  candidate,
  qualification,
  { preflight = preflightQualifiedRelease } = {}
) {
  assert.ok(candidate && Object.getPrototypeOf(candidate) === Object.prototype)
  assert.deepEqual(
    Object.keys(candidate).sort(),
    [
      "sourceSha",
      "engineRevision",
      "webDigest",
      "workerDigest",
      "proxyDigest",
      "runId",
      "runAttempt",
    ].sort()
  )
  for (const key of ["sourceSha", "engineRevision"]) assert.match(candidate[key], /^[a-f0-9]{40}$/)
  for (const key of ["webDigest", "workerDigest", "proxyDigest"])
    assert.match(candidate[key], /^sha256:[a-f0-9]{64}$/)
  for (const key of ["runId", "runAttempt"]) assert.match(candidate[key], /^[1-9][0-9]{0,19}$/)
  assert.match(qualification, /^[a-f0-9]{64}$/)
  const context = await preflight(qualification)
  assert.equal(context.source, candidate.sourceSha)
  for (const [candidateKey, pairKey] of [
    ["sourceSha", "productRevision"],
    ["engineRevision", "engineRevision"],
    ["webDigest", "webDigest"],
    ["workerDigest", "workerDigest"],
    ["proxyDigest", "proxyDigest"],
  ])
    assert.equal(candidate[candidateKey], context.pair?.[pairKey])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await verifyPreparedPair(
      {
        sourceSha: process.env.PREPARED_SOURCE_SHA,
        engineRevision: process.env.PREPARED_ENGINE_REVISION,
        webDigest: process.env.PREPARED_WEB_DIGEST,
        workerDigest: process.env.PREPARED_WORKER_DIGEST,
        proxyDigest: process.env.PREPARED_EGRESS_DIGEST,
        runId: process.env.PREPARED_RUN_ID,
        runAttempt: process.env.PREPARED_RUN_ATTEMPT,
      },
      process.env.PAIRED_QUALIFIED_RELEASE_SHA256
    )
    process.stdout.write("Prepared immutable image tuple matches protected paired release.\n")
  } catch {
    process.stderr.write("Prepared candidate or protected release qualification unavailable.\n")
    process.exitCode = 1
  }
}
