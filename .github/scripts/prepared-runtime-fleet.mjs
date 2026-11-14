import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = "ghcr.io/ecryptoguru/lyrashield-ai"
const repos = {
  web: `${root}/lyrashield-web`,
  worker: `${root}/lyrashield-worker`,
  proxy: `${root}/lyrashield-egress-proxy`,
  broker: `${root}/lyrashield-broker`,
  supervisor: `${root}/lyrashield-supervisor`,
  providerGateway: `${root}/lyrashield-provider-gateway`,
  sandbox: "ghcr.io/ecryptoguru/lyrashield-sandbox",
}
const revision = /^[a-f0-9]{40}$/
const digest = /^sha256:[a-f0-9]{64}$/
const id = /^[1-9][0-9]{0,19}$/
const digestField = (name) => `${name}Digest`

function exact(value, fields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value))
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort())
}

function validatePrepared(prepared) {
  exact(prepared, [
    "productRevision",
    "engineRevision",
    "runId",
    "runAttempt",
    ...Object.keys(repos).map(digestField),
  ])
  assert.match(prepared.productRevision, revision)
  assert.match(prepared.engineRevision, revision)
  assert.match(prepared.runId, id)
  assert.match(prepared.runAttempt, id)
  for (const name of Object.keys(repos)) assert.match(prepared[digestField(name)], digest)
  return prepared
}

export function bindPreparedRuntimeFleet(input) {
  exact(input, ["productRevision", "engineRevision", "runId", "runAttempt", ...Object.keys(repos)])
  const result = {
    productRevision: input.productRevision,
    engineRevision: input.engineRevision,
    runId: input.runId,
    runAttempt: input.runAttempt,
  }
  for (const [name, repo] of Object.entries(repos)) {
    assert.equal(typeof input[name], "string")
    const prefix = `${repo}@`
    assert.ok(input[name].startsWith(prefix))
    result[digestField(name)] = input[name].slice(prefix.length)
  }
  return validatePrepared(result)
}

export function requirePreparedRuntimeFleet(fleet, prepared, identity) {
  validatePrepared(prepared)
  assert.equal(prepared.productRevision, identity.source)
  assert.equal(`${prepared.runId}:${prepared.runAttempt}`, identity.owner)
  for (const field of ["productRevision", "engineRevision", ...Object.keys(repos).map(digestField)])
    assert.equal(fleet[field], prepared[field])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const prepared = bindPreparedRuntimeFleet({
      productRevision: process.env.GITHUB_SHA,
      engineRevision: process.env.ENGINE_REVISION,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      web: process.env.WEB_IMAGE,
      worker: process.env.WORKER_IMAGE,
      proxy: process.env.EGRESS_PROXY_IMAGE,
      broker: process.env.BROKER_IMAGE,
      supervisor: process.env.SUPERVISOR_IMAGE,
      providerGateway: process.env.PROVIDER_GATEWAY_IMAGE,
      sandbox: process.env.SANDBOX_IMAGE,
    })
    assert.ok(process.env.GITHUB_OUTPUT)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Actions supplies its output file
    appendFileSync(process.env.GITHUB_OUTPUT, `prepared_fleet=${JSON.stringify(prepared)}\n`)
  } catch {
    process.stderr.write("Prepared runtime image tuple unavailable.\n")
    process.exitCode = 1
  }
}
