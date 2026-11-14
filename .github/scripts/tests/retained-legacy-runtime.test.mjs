/* eslint-disable security/detect-non-literal-fs-filename -- Paths are confined to this test's freshly created disposable directory. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import {
  LEGACY_PRODUCT,
  LEGACY_ENGINE,
  parseRetainedApproval,
  assertRetainedMode,
  assertRetainedSource,
  assertProbeAcknowledgement,
  readRetainedRuntime,
} from "../retained-legacy-runtime.mjs"

const digest = (n) => `sha256:${n.repeat(64)}`
const source = "a".repeat(40)
const approval = {
  schema: "lyrashield-retained-worker/1",
  sourceSha: source,
  reviewedSourceSha: source,
  workerDigest: digest("b"),
  workerSourceSha: LEGACY_PRODUCT,
  engineRevision: LEGACY_ENGINE,
  sandboxImage: `ghcr.io/ecryptoguru/lyrashield-sandbox@${digest("c")}`,
  workerEnvironmentSha256: "d".repeat(64),
  egressDigest: digest("e"),
  egressSourceSha: LEGACY_PRODUCT,
}
const env = {
  GITHUB_REF: "refs/heads/main",
  DEPLOY_SHA: source,
  RETAINED_WORKER_SOURCE: LEGACY_PRODUCT,
  WORKER_DIGEST: approval.workerDigest,
  ENGINE_REVISION: LEGACY_ENGINE,
  EGRESS_PROXY_DIGEST: approval.egressDigest,
  WORKER_IMAGE: "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker",
  EGRESS_PROXY_IMAGE: "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-egress-proxy",
  RG: "fixture-rg",
  WORKER_VM_NAME: "fixture-worker",
  RETAINED_EGRESS_NAME: "fixture-relay",
  BULLMQ_REDIS_URL: "rediss://example.test",
}
test("protected approval binds the exact candidate and the immutable retained tuple", () => {
  assert.deepEqual(parseRetainedApproval(JSON.stringify(approval), source), approval)
  for (const key of Object.keys(approval)) {
    const missing = { ...approval }
    delete missing[key]
    assert.throws(() => parseRetainedApproval(JSON.stringify(missing), source))
    assert.throws(() =>
      parseRetainedApproval(JSON.stringify({ ...approval, [key]: "unknown" }), source)
    )
  }
  for (const raw of [undefined, "", "null", "[]", JSON.stringify({ ...approval, extra: true })])
    assert.throws(() => parseRetainedApproval(raw, source))
  assert.throws(() => parseRetainedApproval(JSON.stringify(approval), "f".repeat(40)))
  assert.throws(() =>
    parseRetainedApproval(
      JSON.stringify({
        ...approval,
        sandboxImage: "ghcr.io/ecryptoguru/lyrashield-sandbox:latest",
      }),
      source
    )
  )
})
test("retained mode cannot enter maintenance, signed qualification, credential drift or replacement", () => {
  assert.doesNotThrow(() => assertRetainedMode(env, approval))
  for (const [key, value] of [
    ["GITHUB_REF", "refs/heads/other"],
    ["DEPLOY_SHA", "f".repeat(40)],
    ["RETAINED_WORKER_SOURCE", "f".repeat(40)],
    ["WORKER_DIGEST", digest("f")],
    ["ENGINE_REVISION", "f".repeat(40)],
    ["EGRESS_PROXY_DIGEST", digest("f")],
    ["WORKER_IMAGE", "ghcr.io/other/worker"],
    ["EGRESS_PROXY_IMAGE", "ghcr.io/other/relay"],
    ["WEBHOOK_CLAIMS_CUTOVER", "true"],
    ["WEBHOOK_CUTOVER_RECOVERY", "true"],
    ["V26_CUTOVER", "true"],
    ["PAIRED_QUALIFIED_RELEASE_SHA256", "f".repeat(64)],
    ["LYRASHIELD_AI_RESULT_CACHE_MODE", "on"],
  ])
    assert.throws(() => assertRetainedMode({ ...env, [key]: value }, approval), key)
})
test("the protected exact-source review rejects a changed checkout or unavailable Git identity", () => {
  assert.doesNotThrow(() => assertRetainedSource(source, () => source + "\n"))
  assert.throws(() => assertRetainedSource(source, () => "f".repeat(40)))
  assert.throws(() =>
    assertRetainedSource(source, () => {
      throw Error("unavailable")
    })
  )
  assert.throws(() =>
    parseRetainedApproval(
      JSON.stringify({ ...approval, reviewedSourceSha: "f".repeat(40) }),
      source
    )
  )
})

function platform(overrides = {}) {
  const revision = {
    name: "relay-current",
    properties: {
      active: true,
      healthState: "Healthy",
      template: {
        containers: [
          { image: `${env.EGRESS_PROXY_IMAGE}:${LEGACY_PRODUCT}@${approval.egressDigest}` },
        ],
      },
    },
  }
  const calls = []
  const run = (file, args) => {
    calls.push([file, args])
    if (file === "git") return source
    if (args[0] === "containerapp" && args[1] === "show")
      return JSON.stringify({
        properties: {
          configuration: {
            ingress: {
              fqdn: "fixture.region.azurecontainerapps.io",
              traffic: overrides.traffic ?? [{ weight: 100, revisionName: "relay-current" }],
            },
          },
        },
      })
    if (args[0] === "containerapp") return JSON.stringify(overrides.revisions ?? [revision])
    return JSON.stringify(
      overrides.result ?? { value: [{ message: "[stdout]\nRETAINED_WORKER_READY\n[stderr]\n" }] }
    )
  }
  return { run, calls, revision }
}
test("readback composes exact approval, source, relay and physical worker probe", async () => {
  const p = platform()
  await readRetainedRuntime(approval, env, p.run)
  const vm = p.calls.find(([, args]) => args[0] === "vm")
  assert.ok(vm)
  const script = vm[1][vm[1].indexOf("--scripts") + 1]
  assert.match(script, /docker exec -i lyrashield-worker node/)
  assert.match(script, /systemctl is-active --quiet/)
  assert.doesNotMatch(
    script,
    /refresh-secrets|docker run|systemctl (?:restart|stop)|keyvault secret set|\brm\b|\binstall\b/
  )
  assert.ok(script.endsWith("echo RETAINED_WORKER_READY"))
})
test("unavailable, wrong or ambiguous relay/worker readbacks reject", async () => {
  const p = platform()
  for (const overrides of [
    { traffic: [] },
    {
      traffic: [
        { weight: 50, revisionName: "a" },
        { weight: 50, revisionName: "b" },
      ],
    },
    { revisions: [] },
    {
      revisions: [
        { ...p.revision, properties: { ...p.revision.properties, healthState: "Unhealthy" } },
      ],
    },
    {
      revisions: [
        {
          ...p.revision,
          properties: {
            ...p.revision.properties,
            template: { containers: [{ image: env.EGRESS_PROXY_IMAGE + ":latest" }] },
          },
        },
      ],
    },
    { result: { value: [{ message: "[stdout]\n[stderr]\n" }] } },
    { result: { value: [{ message: "RETAINED_WORKER_READY\nRETAINED_WORKER_READY" }] } },
    { result: { value: [{ message: "RETAINED_WORKER_READY\n[stderr]\nfailed" }] } },
  ])
    await assert.rejects(readRetainedRuntime(approval, env, platform(overrides).run))
  await assert.rejects(readRetainedRuntime(approval, { ...env, RG: "$(invalid)" }, p.run))
  await assert.rejects(
    readRetainedRuntime(approval, env, () => {
      throw Error("unavailable")
    })
  )
  for (const result of [
    null,
    { value: [] },
    { value: [{ message: "RETAINED_WORKER_READY" }, { message: "other" }] },
  ])
    assert.throws(() => assertProbeAcknowledgement(result))
})

function probeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "retained-worker-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const live = {
    LYRASHIELD_PRODUCT_REVISION: LEGACY_PRODUCT,
    LYRASHIELD_WORKER_IMAGE_DIGEST: approval.workerDigest,
    LYRASHIELD_ENGINE_REVISION: LEGACY_ENGINE,
    LYRASHIELD_IMAGE: approval.sandboxImage,
    REDIS_URL: env.BULLMQ_REDIS_URL,
  }
  const configEnv = Object.entries(live).map(([key, value]) => `${key}=${value}`)
  const a = {
    ...approval,
    workerEnvironmentSha256: createHash("sha256")
      .update(JSON.stringify(configEnv.sort()))
      .digest("hex"),
  }
  const metadata = {
    State: { Running: true, Health: { Status: "healthy" } },
    Config: {
      Image: env.WORKER_IMAGE + "@" + a.workerDigest,
      Env: configEnv,
      Labels: {
        "org.opencontainers.image.revision": LEGACY_PRODUCT,
        "io.lyrashield.engine.revision": LEGACY_ENGINE,
        "io.lyrashield.accounting.protocol": "reservations/2",
      },
    },
  }
  writeFileSync(join(dir, "inspect.json"), JSON.stringify([metadata]))
  writeFileSync(
    join(dir, "imports.mjs"),
    `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){if(s.startsWith('@lyrashield/')||s==='tsx')return {url:'mock:'+s,shortCircuit:true};return n(s,c)},load(u,c,n){if(u==='mock:tsx')return {format:'module',source:'',shortCircuit:true};if(u==='mock:@lyrashield/db')return {format:'module',source:'export const getSystemPrisma=()=>({scan:{count:async()=>Number(process.env.NONTERMINAL??0)},$disconnect:async()=>{}})',shortCircuit:true};if(u==='mock:@lyrashield/integrations')return {format:'module',source:'const queue=()=>({getJobCounts:async()=>({wait:Number(process.env.JOBS??0),active:0,delayed:0,prioritized:0,paused:0,"waiting-children":0}),close:async()=>{}});export const getScanQueue=queue,getWebhookTrackRetryQueue=queue,closeRedis=async()=>{},assertScanWorkerAvailable=async()=>{if(process.env.UNREADY)throw Error("held or stale heartbeat")}',shortCircuit:true};return n(u,c)}})`
  )
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash\nset -eu\nif [ "$1" = inspect ]; then cat "$FIXTURE/inspect.json"; exit; fi\nshift\nwhile [ "$1" != node ]; do shift; done\nshift\nexec "$NODE" --import "$FIXTURE/imports.mjs" "$@"\n`
  )
  writeFileSync(join(dir, "systemctl"), '#!/bin/sh\n[ -z "${SYSTEMCTL_FAIL:-}" ]\n')
  writeFileSync(
    join(dir, "curl"),
    '#!/bin/sh\nprintf "%s" "${HTTP_STATUS:-200}"\n[ -z "${CURL_FAIL:-}" ]\n'
  )
  for (const cmd of ["docker", "systemctl", "curl"]) chmodSync(join(dir, cmd), 0o700)
  const run = async (extra = {}, requireEmptyQueues = true) => {
    const p = platform()
    await readRetainedRuntime(a, env, p.run, { requireEmptyQueues })
    const vm = p.calls.find(([, args]) => args[0] === "vm")
    const script = vm[1][vm[1].indexOf("--scripts") + 1]
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...live,
        PATH: dir + ":" + process.env.PATH,
        NODE: process.execPath,
        FIXTURE: dir,
        ...extra,
      },
      timeout: 10000,
    })
  }
  return { run, metadata, dir }
}
test("pre-promotion guest probe rejects changed identity, environment, health, queues, admission and relay failure", async (t) => {
  const p = probeFixture(t)
  const positive = await p.run()
  assert.equal(positive.status, 0, positive.stderr)
  for (const extra of [
    { JOBS: "1" },
    { NONTERMINAL: "1" },
    { UNREADY: "1" },
    { CURL_FAIL: "1" },
    { SYSTEMCTL_FAIL: "1" },
    { LYRASHIELD_ENGINE_REVISION: "f".repeat(40) },
    { REDIS_URL: "rediss://other.test" },
    { LYRASHIELD_IMAGE: "mutable:latest" },
  ])
    assert.notEqual((await p.run(extra)).status, 0, JSON.stringify(extra))
  for (const change of [
    (m) => (m.State.Health.Status = "unhealthy"),
    (m) => (m.Config.Labels["io.lyrashield.accounting.protocol"] = "reservations/1"),
    (m) => (m.Config.Image = env.WORKER_IMAGE + ":latest"),
    (m) => m.Config.Env.push("ADDED=drift"),
  ]) {
    const m = structuredClone(p.metadata)
    change(m)
    writeFileSync(join(p.dir, "inspect.json"), JSON.stringify([m]))
    assert.notEqual((await p.run()).status, 0)
  }
})

test("post-promotion identity readback permits newly admitted work but still rejects unhealthy worker", async (t) => {
  const p = probeFixture(t)
  assert.equal((await p.run({ JOBS: "1", NONTERMINAL: "1" }, false)).status, 0)
  assert.notEqual((await p.run({ UNREADY: "1" }, false)).status, 0)
  assert.notEqual((await p.run({ REDIS_URL: "rediss://other.test" }, false)).status, 0)
})

test("relay health requires HTTP 200 and rejects redirects or failed requests", async (t) => {
  const p = probeFixture(t)
  for (const status of ["301", "302", "503", "000"])
    assert.notEqual((await p.run({ HTTP_STATUS: status })).status, 0, status)
  assert.notEqual((await p.run({ CURL_FAIL: "1" })).status, 0)
})
