import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import {
  bindPreparedRuntimeFleet,
  requirePreparedRuntimeFleet,
} from "../prepared-runtime-fleet.mjs"

const { parse } = createRequire(
  new URL("../../../packages/agent-plugin/package.json", import.meta.url)
)("yaml")
const source = "a".repeat(40)
const engine = "b".repeat(40)
const digest = (c) => `sha256:${c.repeat(64)}`
const root = "ghcr.io/ecryptoguru/lyrashield-ai"
const images = {
  productRevision: source,
  engineRevision: engine,
  runId: "12",
  runAttempt: "1",
  web: `${root}/lyrashield-web@${digest("1")}`,
  worker: `${root}/lyrashield-worker@${digest("2")}`,
  proxy: `${root}/lyrashield-egress-proxy@${digest("3")}`,
  broker: `${root}/lyrashield-broker@${digest("4")}`,
  supervisor: `${root}/lyrashield-supervisor@${digest("5")}`,
  providerGateway: `${root}/lyrashield-provider-gateway@${digest("6")}`,
  sandbox: `ghcr.io/ecryptoguru/lyrashield-sandbox@${digest("7")}`,
}

test("preparation binds only exact repository images and run identity", () => {
  const result = bindPreparedRuntimeFleet(images)
  assert.equal(result.productRevision, source)
  assert.equal(result.workerDigest, digest("2"))
  assert.equal(result.sandboxDigest, digest("7"))
  for (const bad of [
    { ...images, worker: images.web },
    { ...images, sandbox: `ghcr.io/attacker/lyrashield-sandbox@${digest("7")}` },
    { ...images, web: `${root}/lyrashield-web:latest` },
    { ...images, runAttempt: "0" },
    { ...images, productRevision: "main" },
    { ...images, unexpected: "value" },
  ])
    assert.throws(() => bindPreparedRuntimeFleet(bad))
})

test("issuer cannot sign a different image tuple or run", () => {
  const prepared = bindPreparedRuntimeFleet(images)
  const identity = { source, owner: "12:1" }
  requirePreparedRuntimeFleet(prepared, prepared, identity)
  for (const changed of [
    { ...prepared, workerDigest: digest("a") },
    { ...prepared, brokerDigest: digest("a") },
    { ...prepared, sandboxDigest: digest("a") },
    { ...prepared, engineRevision: "c".repeat(40) },
  ])
    assert.throws(() => requirePreparedRuntimeFleet(changed, prepared, identity))
  assert.throws(() =>
    requirePreparedRuntimeFleet(prepared, prepared, { ...identity, owner: "13:1" })
  )
  assert.throws(() => requirePreparedRuntimeFleet(prepared, null, identity))
})

test("preparation CLI transports the exact same-run tuple through Actions output", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lyrashield-prepared-fleet-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, "output")
  const result = spawnSync(process.execPath, [".github/scripts/prepared-runtime-fleet.mjs"], {
    env: {
      ...process.env,
      GITHUB_SHA: source,
      ENGINE_REVISION: engine,
      GITHUB_RUN_ID: "12",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: output,
      WEB_IMAGE: images.web,
      WORKER_IMAGE: images.worker,
      EGRESS_PROXY_IMAGE: images.proxy,
      BROKER_IMAGE: images.broker,
      SUPERVISOR_IMAGE: images.supervisor,
      PROVIDER_GATEWAY_IMAGE: images.providerGateway,
      SANDBOX_IMAGE: images.sandbox,
    },
    encoding: "utf8",
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test-owned temporary output
  const raw = readFileSync(output, "utf8")
  assert.equal(raw, `prepared_fleet=${JSON.stringify(bindPreparedRuntimeFleet(images))}\n`)
})

test("release prepares the same tuple before its protected issuer", () => {
  const release = parse(readFileSync(".github/workflows/release-production.yml", "utf8"))
  const prep = parse(
    readFileSync(".github/workflows/prepare-worker-recovery-candidate.yml", "utf8")
  )
  const issuer = parse(readFileSync(".github/workflows/issue-runtime-qualification.yml", "utf8"))
  const prepare = release.jobs["prepare-runtime-images"]
  assert.match(prepare.if, /LYRASHIELD_RUNTIME_FLEET_EVIDENCE != ''/)
  assert.match(prepare.if, /needs\.routing\.outputs\.azure-deploy == 'true'/)
  assert.equal(prepare.uses, "./.github/workflows/prepare-worker-recovery-candidate.yml")
  assert.equal(prepare.with.runtime_qualification, true)
  assert.ok(release.jobs["qualify-runtime"].needs.includes("prepare-runtime-images"))
  assert.match(release.jobs["qualify-runtime"].if, /prepare-runtime-images\.result == 'success'/)
  assert.equal(
    release.jobs["qualify-runtime"].with.prepared_fleet,
    "${{ needs.prepare-runtime-images.outputs.prepared_fleet }}"
  )
  for (const target of ["controller", "supervisor", "provider-gateway"]) {
    const step = prep.jobs.build.steps.find((value) => value.with?.target === target)
    assert.equal(step.if, "inputs.runtime_qualification == true")
    assert.equal(step.with.push, true)
  }
  assert.equal(prep.jobs.rehearse.with.cold_release, "${{ inputs.runtime_qualification == true }}")
  assert.equal(
    issuer.jobs["verify-signing-boundary"].steps.find((s) => s.id === "fleet").env
      .PREPARED_RUNTIME_FLEET,
    "${{ inputs.prepared_fleet }}"
  )
})
