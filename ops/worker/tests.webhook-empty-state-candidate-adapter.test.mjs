import test from "node:test"
import assert from "node:assert/strict"
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
import { canonical, sha256 } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import { fixture } from "../../packages/db/scripts/tests/webhook-empty-state-v2-fixture.mjs"
import { runtimeFingerprint } from "./webhook-empty-state-consumer-identity.mjs"

test("enabled copied candidate adapter survives cold start and crash after either activation without promoting foreign state", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-adapter-disposable-")))
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const config = join(root, "worker-runtime.conf")
  const holder = { files: new Map() }
  globalThis.disposableCandidate = holder
  try {
    for (const path of ["ops/worker", "packages/db/scripts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      cpSync(join(source, path), join(root, path), { recursive: true })
    }
    mkdirSync(join(root, "packages/db/node_modules"), { recursive: true })
    cpSync(
      realpathSync(join(source, "packages/db/node_modules/pg-connection-string")),
      join(root, "packages/db/node_modules/pg-connection-string"),
      { recursive: true }
    )
    const store = join(root, "packages/db/scripts/webhook-empty-state-root-store.mjs")
    writeFileSync(
      store,
      `const h=()=>globalThis.disposableCandidate;export const ROOT=${JSON.stringify(root)},FENCE=ROOT+'/fence.json';export function checkParents(){} export function readPolicy(){return h().policy} export function readAuthorization(){return h().authorization} export function runDirectory(){return ROOT+'/123'} export function readRootFile(p){if(!h().files.has(p))throw Object.assign(Error('absent'),{code:'ENOENT'});return h().files.get(p)} export function atomicRootWrite(p,v){h().files.set(p,v)}`
    )
    writeFileSync(
      join(root, "ops/worker/fixture-fs.mjs"),
      `export * from 'node:fs';import {lstatSync as actual,renameSync as rename} from 'node:fs';export function lstatSync(p){if(p!==${JSON.stringify(config)})throw Error('unsafe fixture FS access');const s=actual(p);return {isSymbolicLink:()=>false,isFile:()=>true,uid:0,nlink:1,size:s.size,mode:0o600}}export function renameSync(a,b){if(globalThis.disposableCandidate.failRename){globalThis.disposableCandidate.failRename=false;throw Error('interrupted rename')}return rename(a,b)}`
    )
    writeFileSync(
      join(root, "ops/worker/fixture-process.mjs"),
      `export function spawnSync(binary,args,options){return globalThis.disposableCandidate.command(binary,args,options)}`
    )
    const candidate = join(root, "ops/worker/webhook-empty-state-candidate.mjs")
    writeFileSync(
      candidate,
      readFileSync(candidate, "utf8")
        .replace("const ENABLED = false", "const ENABLED = true")
        .replace('from "node:child_process"', 'from "./fixture-process.mjs"')
        .replace('from "node:fs"', 'from "./fixture-fs.mjs"')
        .replace('"/etc/lyrashield/worker-runtime.conf"', JSON.stringify(config))
        .replace("pollMs = 2000", "pollMs = 1")
    )
    const connection = join(root, "ops/worker/webhook-empty-state-candidate-connection.mjs")
    writeFileSync(
      connection,
      readFileSync(connection, "utf8").replace(
        'from "node:child_process"',
        'from "./fixture-process.mjs"'
      )
    )
    const { promoteCandidate } = await import(pathToFileURL(candidate))
    for (const crashAfter of [null, "app", "scanner", "rename", "unhealthy-scanner"]) {
      const { receipt, policy } = fixture()
      const issuedAt = new Date().toISOString(),
        expiresAt = new Date(Date.now() + 1800000).toISOString()
      Object.assign(receipt.authorization, { issuedAt, expiresAt })
      Object.assign(policy, { issuedAt, expiresAt })
      const base =
        "/subscriptions/b2f8f58b-18f5-4e49-ac53-06ea04ff0f4c/resourceGroups/LyraShieldAI/providers/Microsoft.App/containerApps/"
      policy.resources.app = base + "lyrashield-app"
      policy.resources.scanner = base + "lyrashield-scanner"
      policy.images = {
        candidate: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${policy.candidate.imageDigest}`,
        app: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@${policy.candidate.imageDigest}`,
        scanner: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@${policy.candidate.imageDigest}`,
      }
      policy.candidateRevisions = { app: "app-candidate", scanner: "scanner-candidate" }
      const env = {
        DATABASE_URL:
          "postgresql://worker_runtime:disposable-only@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres",
        DATABASE_SYSTEM_URL:
          "postgresql://system_admin:disposable-system@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres",
        REDIS_URL: "rediss://disposable-only@redis.invalid:6379/0",
      }
      const fingerprint = runtimeFingerprint(env)
      policy.databaseIdentitySha256 = fingerprint.database.identitySha256
      policy.databasePrincipals = {
        app: "worker_runtime",
        scanner: "worker_runtime",
        worker: "worker_runtime",
        system: "system_admin",
        migration: "postgres",
      }
      policy.redisIdentitySha256 = fingerprint.redis.identitySha256
      policy.credentials.redis = fingerprint.redis.credentialSha256
      policy.candidateCredentials = {}
      for (const role of ["app", "scanner"]) {
        policy.credentials[role] = fingerprint.database.credentialSha256
        policy.candidateCredentials[role] = { system: fingerprint.system.credentialSha256 }
      }
      const proof = {
        schemaVersion: "webhook-empty-state-completion/v2",
        state: "complete",
        authorizationSha256: sha256(canonical(receipt.authorization)),
        receiptSha256: "a".repeat(64),
        sourceSha: policy.sourceSha,
        databaseIdentitySha256: policy.databaseIdentitySha256,
        schemaSha256: "a".repeat(64),
        historySha256: "a".repeat(64),
        indexSha256: "a".repeat(64),
        workerImageDigest: policy.candidate.imageDigest,
      }
      holder.policy = policy
      holder.authorization = receipt.authorization
      holder.files.clear()
      holder.files.set(root + "/123/completion.json", proof)
      holder.files.set(root + "/fence.json", {
        schemaVersion: "webhook-empty-state-fence/v2",
        state: "migration-complete",
        authorization: receipt.authorization,
        receiptSha256: proof.receiptSha256,
        completionSha256: sha256(canonical(proof)),
      })
      writeFileSync(config, "LYRASHIELD_WORKER_IMAGE=fixture-old\n", { mode: 0o600 })
      const active = { app: false, scanner: false }
      let failed = false,
        healthChecks = 0
      holder.command = (binary, args) => {
        const ok = (value) => ({
          status: 0,
          stdout: typeof value === "string" ? value : JSON.stringify(value),
        })
        if (binary === "/usr/bin/az") {
          const role = args.includes("lyrashield-app") ? "app" : "scanner"
          if (args[1] === "revision" && args[2] === "show")
            return ok({
              id: policy.resources[role] + "/revisions/" + policy.candidateRevisions[role],
              name: policy.candidateRevisions[role],
              properties: {
                active: active[role],
                provisioningState: "Provisioned",
                runningState: crashAfter === "unhealthy-scanner" && role === "scanner" ? "Failed" : "Running",
                healthState: crashAfter === "unhealthy-scanner" && role === "scanner" ? "Unhealthy" : "Healthy",
                replicas: active[role] && !(crashAfter === "unhealthy-scanner" && role === "scanner") ? 1 : 0,
                template: {
                  containers: [
                    {
                      image: policy.images[role],
                      env: Object.entries(env).map(([name, value]) => ({ name, value })),
                    },
                  ],
                },
              },
            })
          if (args[1] === "show") return ok({ properties: { configuration: { secrets: [] } } })
          if (args[2] === "activate") {
            active[role] = true
            return ok("")
          }
          if (args[1] === "ingress") {
            if (crashAfter === role && !failed) {
              failed = true
              return { status: 1, stdout: "" }
            }
            return ok("")
          }
          throw Error("unexpected fixture Azure command")
        }
        if (binary === "/usr/bin/systemctl") return ok("")
        if (binary === "/usr/bin/curl")
          return ok('{"status":"ready","checks":{"database":true,"redis":true}}')
        if (binary === "/usr/bin/docker") {
          if (args[0] === "run") return ok(fingerprint)
          if (args[0] === "image") return ok(policy.candidate.sourceSha)
          if (args[0] === "inspect")
            return ok({
              Config: { Image: policy.images.candidate },
              State: {
                Status: "running",
                Health: { Status: ++healthChecks < 3 ? "starting" : "healthy" },
              },
            })
        }
        throw Error("unsafe fixture command boundary")
      }
      holder.failRename = crashAfter === "rename"
      if (crashAfter) {
        await assert.rejects(promoteCandidate())
        assert.equal(holder.files.has(root + "/123/candidate-ready.json"), false)
        if (["app", "scanner"].includes(crashAfter)) assert.equal(active[crashAfter], true)
        if (crashAfter === "unhealthy-scanner") continue
      }
      await promoteCandidate()
      assert.deepEqual(active, { app: true, scanner: true })
      assert.ok(healthChecks >= 3)
      assert.ok(holder.files.has(root + "/123/candidate-ready.json"))
      holder.files.delete(root + "/123/activation-app.json")
      await assert.rejects(promoteCandidate(), /inert/)
      assert.ok(holder.files.has(root + "/fence.json"), "maintenance fence retained")
    }
  } finally {
    delete globalThis.disposableCandidate
    rmSync(root, { recursive: true, force: true })
  }
})
