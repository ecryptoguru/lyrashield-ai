import assert from "node:assert/strict"
import test from "node:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
const hex = (size) => randomBytes(size).toString("hex")
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "v26-cli-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = {
    ...process.env,
    V26_CLI_TEST_DIRECTORY: directory,
    RUNNER_TEMP: directory,
    GITHUB_ENV: join(directory, "github-env"),
    RG: "fixture-rg",
    APP_NAME: "fixture-app",
    SCANNER_NAME: "fixture-scanner",
    WORKER_VM_NAME: "fixture-worker",
    DEPLOY_SHA: hex(20),
    ENGINE_REVISION: hex(20),
    WEB_DIGEST: `sha256:${hex(32)}`,
    WORKER_DIGEST: `sha256:${hex(32)}`,
    WEB_IMAGE: "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web",
    WORKER_IMAGE: "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker",
    DATABASE_DIRECT_URL: "postgresql://migration@127.0.0.1/fixture",
    V26_APP_TEST_URL: "postgresql://app_runtime@127.0.0.1/fixture",
    V26_WORKER_TEST_URL: "postgresql://worker_runtime@127.0.0.1/fixture",
    BULLMQ_REDIS_URL: `redis://:${hex(16)}@127.0.0.1`,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    APP_URL: "https://app.example",
    SCANNER_URL: "https://scanner.example",
  }
  // Match deploy-azure.yml outputs: the source tag is retained beside the
  // verified immutable digest for both baseline and candidate references.
  env.WEB_IMAGE += `:${env.DEPLOY_SHA}`
  env.WORKER_IMAGE += `:${env.DEPLOY_SHA}`
  const path = join(directory, "platform.json")
  // Test paths are confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(
    path,
    JSON.stringify({
      active: true,
      worker: true,
      schema: false,
      grants: false,
      candidate: false,
      stop: null,
      grantedSql: [],
      oldWeb: `${env.WEB_IMAGE.split(":")[0]}:${"a".repeat(40)}@sha256:${hex(32)}`,
      oldWorker: `${env.WORKER_IMAGE.split(":")[0]}:${"a".repeat(40)}@sha256:${hex(32)}`,
    })
  )
  // Test paths are confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(
    join(directory, "entrypoints.mjs"),
    'export const SCAN_ACCOUNTING_PROTOCOL="reservations/2"; export function createScan(){}; export function lockUserScanAdmission(){}; export function releaseStoppedScanSlot(){}; export function reserveScanCapacity(){}; export function confirmScanCapacityStopped(){};'
  )
  // Test paths are confined to this test’s disposable directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const get = () => JSON.parse(readFileSync(path, "utf8")),
    // Test paths are confined to this test’s disposable directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    set = (updates) => writeFileSync(path, JSON.stringify({ ...get(), ...updates }))
  const run = (phase) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "./.github/scripts/tests/fixtures/v26-cli-preload.mjs",
        ".github/scripts/v26-cutover.mjs",
        phase,
      ],
      { env, encoding: "utf8", timeout: 20000 }
    )
  return {
    directory,
    env,
    get,
    set,
    run,
    pass(phase) {
      const result = run(phase)
      assert.equal(result.status, 0, `${phase}: ${result.stdout}\n${result.stderr}`)
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /app_runtime|worker_runtime|postgresql:|redis:\/\//
      )
      return result
    },
  }
}
function beforeMigration(f) {
  for (const phase of ["prepare", "claim", "quiesce", "before-migrate"]) f.pass(phase)
}
function afterMigration(f) {
  beforeMigration(f)
  f.set({ schema: true })
  f.pass("after-migrate")
  f.set({ candidate: true, active: true, worker: true })
  f.pass("verify")
}
test("actual controller and VM-state CLIs complete with distinct derived runtime roles and real durable receipt", (t) => {
  const f = fixture(t)
  afterMigration(f)
  assert.equal(f.get().stop !== null, true)
  f.pass("release")
  assert.equal(f.get().stop, null)
  assert.equal(
    // Test paths are confined to this test’s disposable directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    JSON.parse(readFileSync(join(f.directory, "v26-cutover.json"), "utf8")).phase,
    "COMPLETE"
  )
  assert.equal(f.get().grantedSql.length, 2)
  assert.ok(f.get().grantedSql.some((sql) => sql.includes('TO "app_runtime"')))
  assert.ok(f.get().grantedSql.some((sql) => sql.includes('TO "worker_runtime"')))
})
test("actual CLI migration failure, candidate failure and foreign stop retain ownership without restoring old writers", (t) => {
  const f = fixture(t)
  beforeMigration(f)
  assert.notEqual(f.run("after-migrate").status, 0)
  assert.equal(f.get().stop !== null, true)
  assert.equal(f.get().active, false)
  assert.equal(f.get().worker, false)
  f.set({ schema: true })
  f.pass("after-migrate")
  f.set({ candidate: true, active: true, worker: true, failure: "readiness" })
  assert.notEqual(f.run("verify").status, 0)
  f.pass("hold")
  assert.equal(f.get().active, false)
  assert.equal(f.get().stop !== null, true)
  f.set({ stop: "foreign-stop" })
  assert.notEqual(f.run("release").status, 0)
  assert.equal(f.get().stop, "foreign-stop")
})
test("actual CLI blocks incomplete maintenance and image qualification before a new mutation", (t) => {
  const f = fixture(t)
  f.pass("prepare")
  f.pass("claim")
  const held = f.get().stop
  assert.notEqual(f.run("prepare").status, 0)
  assert.equal(f.get().stop, held)
  assert.equal(f.get().active, true)
})

test("actual CLI lost release acknowledgement reconciles the exact durable release intent", (t) => {
  const f = fixture(t)
  afterMigration(f)
  f.set({ failure: "cas-ack-loss" })
  f.pass("release")
  assert.equal(f.get().stop, null)
  assert.equal(
    // Test paths are confined to this test’s disposable directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    JSON.parse(readFileSync(join(f.directory, "v26-cutover.json"), "utf8")).phase,
    "COMPLETE"
  )
  assert.notEqual(f.run("hold").status, 0)
  assert.equal(f.get().active, true)
})
test("actual CLI completion fsync failure never recreates admission or deactivates the released healthy fleet", (t) => {
  const f = fixture(t)
  afterMigration(f)
  f.set({ failure: "completion-fsync" })
  assert.notEqual(f.run("release").status, 0)
  assert.equal(f.get().stop, null)
  assert.equal(
    // Test paths are confined to this test’s disposable directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    JSON.parse(readFileSync(join(f.directory, "v26-cutover.json"), "utf8")).phase,
    "RELEASE_INTENT"
  )
  assert.notEqual(f.run("hold").status, 0)
  assert.equal(f.get().active, true)
  assert.equal(f.get().candidate, true)
  assert.notEqual(f.run("prepare").status, 0)
})
test("actual CLI uncertain migration commit keeps admission held and blocks automatic migration reentry", (t) => {
  const f = fixture(t)
  beforeMigration(f)
  const stop = f.get().stop
  f.set({ schema: true })
  assert.notEqual(f.run("before-migrate").status, 0)
  assert.notEqual(f.run("prepare").status, 0)
  assert.equal(f.get().stop, stop)
  assert.equal(f.get().active, false)
  assert.equal(f.get().worker, false)
})

test("workflow tag@digest controller inputs remain usable for the next release within Azure's 4096-byte tail", (t) => {
  const f = fixture(t)
  afterMigration(f)
  f.pass("release")
  // Retain a realistic multi-revision baseline and checksummed proof history
  // on the VM; the transport must return only bounded validated status.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const receipt = JSON.parse(readFileSync(join(f.directory, "v26-cutover.json"), "utf8"))
  assert.match(receipt.baseline.workerImage, /lyrashield-worker:[a-f0-9]{40}@sha256:[a-f0-9]{64}$/)
  assert.match(receipt.baseline.fleet[0].image, /lyrashield-web:[a-f0-9]{40}@sha256:[a-f0-9]{64}$/)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) > 3072)
  f.env.GITHUB_RUN_ID = "456"
  f.env.DEPLOY_SHA = hex(20)
  // The installed image remains the prior exact candidate while a new source
  // is qualified. Ordinary releases must not need the full completed receipt.
  f.pass("prepare")
  assert.ok(f.get().lastProbeBytes < 4096)
  assert.equal(f.get().lastProbeMarkerRetained, true)
  const prepared = JSON.parse(
    // Read only this fixture’s private controller receipt.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(join(f.directory, "lyrashield-v26-controller.json"), "utf8")
  )
  assert.equal(prepared.schema, "current")
  assert.match(prepared.webImage, /lyrashield-web:[a-f0-9]{40}@sha256:/)
  assert.match(prepared.workerImage, /lyrashield-worker:[a-f0-9]{40}@sha256:/)
})
