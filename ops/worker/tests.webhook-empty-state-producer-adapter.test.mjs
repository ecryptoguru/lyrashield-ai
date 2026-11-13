import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { fixture } from "../../packages/db/scripts/tests/webhook-empty-state-v2-fixture.mjs"
import { canonical, sha256 } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { advancePhase, PHASES } from "./webhook-empty-state-phases.mjs"
import { appConnectionProbeSource } from "./webhook-empty-state-producer.mjs"

test("embedded producer connection probe fails closed without explicit verified TLS", () => {
  const base =
    "postgresql://worker_runtime:disposable-only@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres"
  const source = appConnectionProbeSource("fixture-resource", "2026-10-06T00:00:00.000Z")
  const run = (url, extra = {}) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      timeout: 5000,
      env: { DATABASE_URL: url, ...extra },
    })
  for (const [url, extra] of [
    [base, { PGSSLMODE: "verify-full" }],
    [`${base}?sslmode=disable`, {}],
    [`${base}?sslmode=require`, {}],
    [`${base}?sslmode=verify-full&sslmode=verify-full`, {}],
    [`${base}?sslmode=verify-full&uselibpqcompat=true`, {}],
  ]) {
    assert.notEqual(run(url, extra).status, 0)
  }
  const result = run(`${base}?sslmode=verify-full`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).resourceId, "fixture-resource")
})

test("enabled copied producer executes resume/rehold and completed workflow collect replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "producer-adapter-disposable-"))),
    source = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const holder = {
    files: new Map(),
    output: "",
    emit(value) {
      this.output += value
    },
  }
  globalThis.disposableProducer = holder
  try {
    for (const path of ["ops/worker", "packages/db/scripts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      cpSync(join(source, path), join(root, path), { recursive: true })
    }
    const parser = realpathSync(
      createRequire(new URL("../../packages/db/package.json", import.meta.url)).resolve(
        "pg-connection-string"
      )
    )
    mkdirSync(join(root, "node_modules"))
    cpSync(dirname(parser), join(root, "node_modules/pg-connection-string"), { recursive: true })
    writeFileSync(
      join(root, "packages/db/scripts/webhook-empty-state-root-store.mjs"),
      `const h=()=>globalThis.disposableProducer;export const ROOT=${JSON.stringify(root)},FENCE=ROOT+'/fence.json';export function checkParents(){} export function readPolicy(){return h().policy} export function readAuthorization(){return h().authorization} export function runDirectory(){return ROOT+'/123'} export function readRootFile(p){if(!h().files.has(p))throw Object.assign(Error('absent'),{code:'ENOENT'});return h().files.get(p)} export function atomicRootWrite(p,v){if(h().failPersist&&p.endsWith('/progress.json')&&v.phase==='resume')throw Error('fixture disk failure');h().files.set(p,v);if(h().failAfterRename&&p.endsWith('/progress.json')&&v.phase==='resume')throw Error('fixture directory fsync failure')}`
    )
    writeFileSync(
      join(root, "ops/worker/fixture-fs.mjs"),
      `export {readFileSync} from 'node:fs';export function lstatSync(p){if(!p.startsWith(${JSON.stringify(root)}+'/'))throw Error('unsafe fixture FS');return {isSymbolicLink:()=>false,isFile:()=>true,uid:0,mode:0o600,nlink:1}}export function unlinkSync(p){if(p!==${JSON.stringify(root)}+'/fence.json')throw Error('unsafe unlink');globalThis.disposableProducer.files.delete(p)}`
    )
    writeFileSync(
      join(root, "ops/worker/fixture-process.mjs"),
      `export function spawnSync(binary,args,options){return globalThis.disposableProducer.command(binary,args,options)}`
    )
    const path = join(root, "ops/worker/webhook-empty-state-producer.mjs")
    const code = readFileSync(path, "utf8")
      .replace("PRODUCTION_CUTOVER_ENABLED = false", "PRODUCTION_CUTOVER_ENABLED = true")
      .replace('from "node:child_process"', 'from "./fixture-process.mjs"')
      .replace('from "node:fs"', 'from "./fixture-fs.mjs"')
      .replace(
        'const BUNDLE = "/opt/lyrashield-worker-host"',
        `const BUNDLE = ${JSON.stringify(root)}`
      )
      .replace(
        'const WORKER_ENV = "/etc/lyrashield/worker.env"',
        `const WORKER_ENV = ${JSON.stringify(root + "/worker.env")}`
      )
      .replace(
        'const MIGRATION_ENV = "/etc/lyrashield/webhook-empty-state.env"',
        `const MIGRATION_ENV = ${JSON.stringify(root + "/migration.env")}`
      )
      .replace("async function main() {", "export async function main() {")
      .replace("process.argv.slice(2), policy", "globalThis.disposableProducer.args, policy")
      .replaceAll("process.stdout.write(", "globalThis.disposableProducer.emit(")
    writeFileSync(path, code)
    const { main } = await import(pathToFileURL(path)),
      { receipt, policy } = fixture()
    const issuedMs = Date.now(),
      issuedAt = new Date(issuedMs).toISOString(),
      expiresAt = new Date(issuedMs + 1800000).toISOString()
    Object.assign(receipt.authorization, { issuedAt, expiresAt, producerSha256: sha256(code) })
    Object.assign(policy, { issuedAt, expiresAt, producerSha256: sha256(code) })
    receipt.evidence.observedAt = issuedAt
    receipt.evidence.worker.stopAt = issuedAt
    const base =
      "/subscriptions/b2f8f58b-18f5-4e49-ac53-06ea04ff0f4c/resourceGroups/LyraShieldAI/providers/"
    policy.resources.app = base + "Microsoft.App/containerApps/lyrashield-app"
    policy.resources.scanner = base + "Microsoft.App/containerApps/lyrashield-scanner"
    policy.resources.worker = base + "Microsoft.Compute/virtualMachines/lyrashield-worker"
    policy.resources.system = policy.resources.worker
    policy.resources.migration = "migration"
    policy.resources.backup = "backup"
    for (const name of Object.keys(policy.resources)) {
      receipt.evidence.database[name].resourceId = policy.resources[name]
      receipt.evidence.database[name].observedAt = issuedAt
    }
    for (const [index, name] of ["app", "scanner"].entries())
      receipt.evidence.writers[index].resourceId = policy.resources[name]
    const image = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${policy.candidate.imageDigest}`
    policy.images = Object.fromEntries(
      ["candidate", "fallback", "observer", "stopped"].map((name) => [name, image])
    )
    policy.principalObjectId = "b08289b5-8229-47bf-9d2f-7a8fcea7dfc1"
    const stop = canonical({
      operator: "github-actions",
      reason: "webhook-empty-state",
      owner: receipt.authorization.owner,
      runId: policy.runId,
      sourceSha: policy.sourceSha,
      nonceSha256: sha256(policy.nonce),
      at: issuedAt,
    })
    policy.admissionValueSha256 = sha256(stop)
    receipt.evidence.redis.valueSha256 = sha256(stop)
    policy.backup.createdAt = new Date(Date.now() - 7200000).toISOString()
    policy.restore.completedAt = new Date(Date.now() - 3600000).toISOString()
    policy.restore.backupSha256 = sha256(canonical(policy.backup))
    holder.policy = policy
    holder.authorization = receipt.authorization
    holder.args = ["resume", policy.runId, "1", policy.sourceSha, policy.nonce]
    holder.key = stop
    let state
    for (const phase of PHASES.slice(0, -1))
      state = advancePhase(state, phase, receipt.authorization, policy)
    const progress = root + "/123/progress.json",
      fence = root + "/fence.json"
    holder.files.set(progress, state)
    holder.files.set(fence, { authorization: receipt.authorization })
    holder.files.set(root + "/123/receipt.json", receipt)
    holder.files.set(root + "/123/candidate-ready.json", {
      authorizationSha256: sha256(canonical(receipt.authorization)),
      completionSha256: sha256(canonical({ state: "complete" })),
    })
    holder.files.set(root + "/123/completion.json", { state: "complete" })
    let failPublic = true
    holder.command = (binary, args) => {
      if (binary === "/usr/bin/curl")
        return failPublic
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: '{"status":"ready","checks":{"worker":true}}' }
      assert.equal(binary, "/usr/bin/docker")
      const phase = args.at(-2),
        raw = args.at(-1)
      assert.equal(raw, stop)
      if (phase === "assert") {
        assert.equal(holder.key, stop)
      } else if (phase === "release-retry") {
        assert.ok(holder.key === stop || holder.key === null)
        holder.key = null
        if (holder.lostReleaseAck) {
          holder.lostReleaseAck = false
          return { status: 1, stdout: "" }
        }
      } else if (phase === "claim") {
        assert.ok(holder.key === null || holder.key === stop)
        holder.key = stop
      } else throw Error("unsafe fixture command")
      return { status: 0, stdout: "" }
    }
    await assert.rejects(main())
    assert.equal(holder.key, stop)
    assert.equal(holder.files.get(progress).phase, "candidate")
    assert.ok(holder.files.has(fence))
    failPublic = false
    holder.failPersist = true
    await assert.rejects(main())
    assert.equal(holder.key, stop)
    assert.ok(holder.files.has(fence))
    assert.equal(holder.files.get(progress).phase, "candidate")
    holder.failPersist = false
    holder.lostReleaseAck = true
    await assert.rejects(main())
    assert.equal(holder.key, stop, "lost DEL acknowledgment restores owned hold")
    assert.ok(holder.files.has(fence))
    holder.failAfterRename = true
    await assert.rejects(main())
    assert.equal(
      holder.files.get(progress).phase,
      "resume",
      "rename committed before fsync failure"
    )
    assert.equal(holder.key, stop)
    assert.ok(holder.files.has(fence))
    holder.failAfterRename = false
    await main()
    assert.equal(holder.key, null)
    assert.equal(holder.files.get(progress).phase, "resume")
    assert.equal(holder.files.has(fence), false)
    // Execute the real replay branch for every earlier workflow step, including
    // the exact digest output the shell collect step requires before attestation.
    for (const phase of PHASES) {
      holder.args[0] = phase
      holder.output = ""
      await main()
      assert.ok(holder.output.split("\n").includes(`EMPTY_STATE_PHASE_COMPLETE=${phase}`))
      if (phase === "collect")
        assert.deepEqual(
          holder.output.split("\n").filter((line) => /^[a-f0-9]{64}$/.test(line)),
          [sha256(canonical(receipt))]
        )
    }
  } finally {
    delete globalThis.disposableProducer
    rmSync(root, { recursive: true, force: true })
  }
})
