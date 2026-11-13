import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const script = path.join(root, ".github/scripts/webhook-claims-vm.sh")
const helper = path.join(root, "ops/worker/webhook-cutover-recovery.mjs")
const originalRunId = "37516632066"
const originalOwner = `${originalRunId}:1`
const originalSource = "a".repeat(40)
const recoveryRunId = "37520000000"
const recoveryAttempt = "2"
const recoverySource = "b".repeat(40)
const finalizerRunId = "37530000000"
const finalizerAttempt = "1"
const finalizerSource = "e".repeat(40)
const engineRevision = "d".repeat(40)
const workerImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"c".repeat(64)}`
const webImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"f".repeat(64)}`
const databaseUrl = "postgresql://worker:fixture@db.example:6432/lyrashield?schema=public"
const systemUrl = "postgresql://system:fixture@db.example:6432/lyrashield?schema=public"
const redisUrl = "rediss://fixture:fixture@redis.example:6379/0"
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const runtimeHashes = {
  databaseUrlSha256: sha256(databaseUrl),
  databaseSystemUrlSha256: sha256(systemUrl),
  redisUrlSha256: sha256(redisUrl),
}

function executable(directory, name, source) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`)
  chmodSync(file, 0o755)
  return file
}

function makeReceipt(status = "release-intent") {
  const admissionStopValue = JSON.stringify({
    operator: "github-actions",
    reason: "webhook-claims-cutover",
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
  })
  const candidate = {
    recoveryRunId,
    recoveryAttempt: Number(recoveryAttempt),
    sourceRevision: recoverySource,
    engineRevision,
    workerImage,
    protocol: "durable-claims/2",
  }
  const release = {
    runId: recoveryRunId,
    attempt: Number(recoveryAttempt),
    sourceRevision: recoverySource,
    engineRevision,
    workerImage,
    protocol: "durable-claims/2",
    status,
    startedAt: "2026-10-07T00:00:00.000Z",
    ...(status === "released" ? { releasedAt: "2026-10-07T00:00:01.000Z" } : {}),
  }
  return {
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
    admissionStopValue,
    phase: "writers-stopped",
    attempts: [1, 2],
    lastAttempt: 2,
    previousWorkerImage: workerImage,
    recoveryCandidates: [candidate],
    recoveryReleases: [release],
    ...runtimeHashes,
  }
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-postrelease-complete-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const receiptPath = path.join(directory, "webhook-claims-cutover.json")
  const archivePath = path.join(directory, `webhook-claims-cutover-completed-${originalRunId}.json`)
  const configPath = path.join(directory, "worker-runtime.conf")
  const environmentPath = path.join(directory, "worker.env")
  const envLibPath = path.join(directory, "worker-env.sh")
  const callsPath = path.join(directory, "calls.jsonl")
  const receipt = makeReceipt(options.releaseStatus ?? "release-intent")
  const activeText = JSON.stringify(receipt)
  if (!options.archiveOnly) writeFileSync(receiptPath, activeText, { mode: 0o600 })
  else {
    const released = {
      ...receipt.recoveryReleases[0],
      status: "released",
      releasedAt: "2026-10-07T00:00:01.000Z",
    }
    const archived = {
      ...receipt,
      phase: "completed",
      recoveryReleases: [released],
      recoveryCompleted: {
        ...released,
        completedAt: "2026-10-07T00:00:02.000Z",
      },
    }
    writeFileSync(archivePath, JSON.stringify(archived), { mode: 0o600 })
  }
  if (options.existingArchive)
    writeFileSync(archivePath, JSON.stringify(options.existingArchive), { mode: 0o600 })
  writeFileSync(
    configPath,
    `LYRASHIELD_WORKER_IMAGE=${workerImage}\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/sandbox@sha256:${"9".repeat(64)}\n`
  )
  writeFileSync(environmentPath, "")
  writeFileSync(envLibPath, "lyrashield_worker_env_args() { :; }\n")
  writeFileSync(callsPath, "")

  executable(
    directory,
    "stat",
    `const args=process.argv.slice(2); if(args[0]==="-c"&&args[1]==="%u:%a"){console.log("0:600");process.exit(0)} process.exit(2);`
  )
  executable(directory, "chown", `process.exit(0);`)
  executable(directory, "sync", `process.exit(0);`)
  executable(
    directory,
    "docker",
    `
const fs=require("node:fs");
const {spawnSync}=require("node:child_process");
const {pathToFileURL}=require("node:url");
const args=process.argv.slice(2);
const log=${JSON.stringify(callsPath)};
const record=(command)=>fs.appendFileSync(log,JSON.stringify(command)+"\\n");
record(["docker",...args]);
const run=async()=>{
 if(args[0]==="image"&&args[1]==="inspect"){const format=args[args.indexOf("--format")+1]||"";if(format.includes("engine.revision")){console.log(${JSON.stringify(engineRevision)});process.exit(0)}process.exit(2)}
 if(args[0]==="inspect"){const format=args[args.indexOf("--format")+1]||"";if(format.includes("Health.Status")){console.log("healthy");process.exit(0)}if(format.includes("Config.Image")){console.log(${JSON.stringify(workerImage)});process.exit(0)}process.exit(2)}
 if(args[0]==="exec"){
  if(args.includes("printenv")){const key=args[args.indexOf("printenv")+1];const values={LYRASHIELD_PRODUCT_REVISION:${JSON.stringify(recoverySource)},LYRASHIELD_ENGINE_REVISION:${JSON.stringify(engineRevision)},LYRASHIELD_WORKER_IMAGE_DIGEST:"sha256:${"c".repeat(64)}"};process.stdout.write(values[key]||"");process.exit(0)}
  if(args.includes("--input-type=module")){console.log(JSON.stringify(${JSON.stringify(runtimeHashes)}));process.exit(0)}
  process.exit(2)
 }
 if(args[0]==="run"){
  const codeIndex=args.indexOf("-e");if(codeIndex<0)process.exit(2);
  const code=args[codeIndex+1]||"";const values=args.slice(codeIndex+2);
  const recovery=await import(pathToFileURL(${JSON.stringify(helper)}).href);
  const expected={ownerRunId:${JSON.stringify(originalRunId)},ownerSourceSha:${JSON.stringify(originalSource)},owner:${JSON.stringify(originalOwner)},recoveryRunId:${JSON.stringify(recoveryRunId)},recoveryAttempt:Number(${JSON.stringify(recoveryAttempt)}),sourceRevision:${JSON.stringify(recoverySource)},engineRevision:${JSON.stringify(engineRevision)},workerImage:${JSON.stringify(workerImage)}};
  const parse=(index)=>JSON.parse(values[index]);
  if(code.includes("assertWebhookRecoveryCandidate")&&code.includes("WEBHOOK_RECOVERY_RUNTIME_VERIFIED")){
   if(process.env.RUNTIME_PROOF_FAIL)process.exit(1);
   const receipt=parse(0);if(receipt.phase==="completed")recovery.assertCompletedWebhookRecoveryReceipt(receipt,expected);else recovery.assertWebhookRecoveryCandidate(receipt,expected);console.log("WEBHOOK_RECOVERY_RUNTIME_VERIFIED");process.exit(0)
  }
  if(code.includes("const redis=new Redis")&&code.includes("Original admission stop changed")){
   const receipt=parse(0);const mode=values[1];const ownerRun=values[2],ownerSource=values[3],owner=values[4];
   if(ownerRun!==${JSON.stringify(originalRunId)}||ownerSource!==${JSON.stringify(originalSource)}||owner!==${JSON.stringify(originalOwner)})process.exit(1);
   if(receipt.phase==="completed")recovery.assertCompletedWebhookRecoveryReceipt(receipt,expected);else recovery.assertWebhookRecoveryCandidate(receipt,expected);
   const redisValue=process.env.REDIS_VALUE||"null";const stop=receipt.admissionStopValue;
   if(mode==="release"&&redisValue!=="null"&&redisValue!==stop)process.exit(1);
   if(mode==="release"&&redisValue===stop)process.exit(1);
   if(mode==="completed"&&redisValue!=="null")process.exit(1);
   console.log(redisValue==="null"?"WITHOUT_ADMISSION_STOP":"ADMISSION_HELD");process.exit(0)
  }
  const source=code.replace("file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs",pathToFileURL(${JSON.stringify(helper)}).href);
  const child=spawnSync(process.execPath,["--input-type=module","-e",source,...values],{encoding:"utf8",env:process.env});
  if(child.stdout)process.stdout.write(child.stdout);if(child.stderr)process.stderr.write(child.stderr);process.exit(child.status??1)
 }
 process.exit(2)
};run().catch((error)=>{console.error(error.stack);process.exit(1)});
`
  )
  executable(
    directory,
    "systemctl",
    `
const fs=require("node:fs");const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(["systemctl",...args])+"\\n");
if(args[0]==="is-active"){if(args.includes("--quiet")){process.exit(0)}console.log("active");process.exit(0)}
if(args[0]==="is-enabled"){console.log("enabled");process.exit(0)}
process.exit(2);
`
  )

  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    REPO_ROOT: root,
    LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE: receiptPath,
    LYRASHIELD_WORKER_RUNTIME_CONFIG: configPath,
    LYRASHIELD_WORKER_ENV_FILE: environmentPath,
    LYRASHIELD_WORKER_ENV_LIB: envLibPath,
    DATABASE_URL: databaseUrl,
    DATABASE_SYSTEM_URL: systemUrl,
    REDIS_URL: redisUrl,
    REDIS_VALUE: options.redisValue ?? "null",
    LYRASHIELD_PRODUCT_REVISION: recoverySource,
    LYRASHIELD_ENGINE_REVISION: engineRevision,
    LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  }

  function run(changes = {}) {
    const args = [
      script,
      "complete-postrelease",
      recoverySource,
      `${recoveryRunId}:${recoveryAttempt}`,
      recoveryRunId,
      "",
      recoveryAttempt,
      originalRunId,
      originalSource,
      originalOwner,
      recoveryRunId,
      recoveryAttempt,
      recoverySource,
      changes.finalizerRunId ?? finalizerRunId,
      changes.finalizerAttempt ?? finalizerAttempt,
      changes.finalizerSource ?? finalizerSource,
      changes.workerImage ?? workerImage,
      webImage,
    ]
    return spawnSync("sh", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...(changes.env ?? {}) },
    })
  }

  return { run, callsPath, receiptPath, archivePath, activeText, env }
}

function assertNoRedisOrWorkerMutation(calls, { requireRedisRead = false } = {}) {
  const entries = calls
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  let redisRead = false
  for (const [kind, ...args] of entries) {
    if (kind === "systemctl")
      assert.ok(!["start", "stop", "restart", "enable", "disable"].includes(args[0]))
    if (kind !== "docker") continue
    assert.ok(!["start", "stop", "restart", "rm"].includes(args[0]))
    if (args[0] === "run") {
      assert.ok(
        args.includes("--pull=never"),
        "post-release probes must not pull or change worker images"
      )
      const code = args[args.indexOf("-e") + 1] ?? ""
      if (code.includes("redis.get")) redisRead = true
      assert.doesNotMatch(code, /redis\.(?:set|eval|del)|redis\.call\(["'](?:SET|DEL|EVAL)/i)
      assert.doesNotMatch(
        code,
        /prisma migrate deploy|systemctl (?:start|stop|restart|enable|disable)/i
      )
    }
  }
  if (requireRedisRead)
    assert.equal(redisRead, true, "completion must prove that the admission stop is absent")
}

function assertCompletedArchive(file) {
  const assertTimestamp = (value) => {
    assert.equal(typeof value, "string")
    assert.ok(Number.isFinite(Date.parse(value)))
    assert.equal(new Date(value).toISOString(), value)
  }
  const archived = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(archived.phase, "completed")
  assert.equal(archived.owner, originalOwner)
  assert.equal(archived.runId, originalRunId)
  assert.equal(archived.productRevision, originalSource)
  assert.equal(archived.admissionStopValue, makeReceipt().admissionStopValue)
  assert.deepEqual(archived.attempts, [1, 2])
  assert.equal(archived.lastAttempt, 2)
  for (const [key, value] of Object.entries(runtimeHashes)) assert.equal(archived[key], value)
  assert.equal(archived.recoveryReleases.at(-1).status, "released")
  assert.equal(archived.recoveryReleases.at(-1).runId, recoveryRunId)
  assert.equal(archived.recoveryReleases.at(-1).attempt, Number(recoveryAttempt))
  assert.equal(archived.recoveryReleases.at(-1).sourceRevision, recoverySource)
  const { completedAt: finalizationAt, ...finalization } = archived.recoveryFinalization
  assert.deepEqual(finalization, {
    runId: finalizerRunId,
    attempt: Number(finalizerAttempt),
    operationsSourceRevision: finalizerSource,
    originalRunId,
    originalOwner,
    originalSourceSha: originalSource,
    recoveryRunId,
    recoveryAttempt: Number(recoveryAttempt),
    recoverySourceSha: recoverySource,
    engineRevision,
    preparedWorkerImage: workerImage,
    preparedWebImage: webImage,
  })
  assertTimestamp(finalizationAt)
  assertTimestamp(archived.recoveryReleases.at(-1).releasedAt)
  const { completedAt, ...completed } = archived.recoveryCompleted
  assert.deepEqual(completed, archived.recoveryReleases.at(-1))
  assertTimestamp(completedAt)
  return archived
}

for (const releaseStatus of ["release-intent", "released"]) {
  test(`complete-postrelease reconciles ${releaseStatus} into an immutable archived receipt without runtime mutation`, (t) => {
    const f = fixture(t, { releaseStatus })
    const result = f.run()
    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}\n${readFileSync(f.callsPath, "utf8")}`
    )
    assert.equal(
      result.stdout.split(/\r?\n/).filter((line) => line === "WEBHOOK_RECOVERY_COMPLETE").length,
      1
    )
    assert.equal(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => line === "WEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE").length,
      1
    )
    assert.equal(existsSync(f.receiptPath), false)
    const archived = assertCompletedArchive(f.archivePath)
    const retry = f.run({
      finalizerRunId: "37530000001",
      finalizerAttempt: "2",
      finalizerSource: "9".repeat(40),
    })
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`)
    assert.ok(
      retry.stdout
        .split(/\r?\n/)
        .includes(`WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_RUN_ID=${finalizerRunId}`)
    )
    assert.deepEqual(JSON.parse(readFileSync(f.archivePath, "utf8")), archived)
    assertNoRedisOrWorkerMutation(readFileSync(f.callsPath, "utf8"), { requireRedisRead: true })
  })
}

test("complete-postrelease archive-only retry reconciles lost acknowledgement idempotently", (t) => {
  const f = fixture(t, { archiveOnly: true })
  const before = readFileSync(f.archivePath, "utf8")
  const result = f.run()
  assert.equal(
    result.status,
    0,
    `${result.stdout}\n${result.stderr}\n${readFileSync(f.callsPath, "utf8")}`
  )
  assert.equal(
    result.stdout.split(/\r?\n/).filter((line) => line === "WEBHOOK_RECOVERY_COMPLETE").length,
    1
  )
  assert.equal(
    result.stdout
      .split(/\r?\n/)
      .filter((line) => line === "WEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE").length,
    1
  )
  assert.ok(result.stdout.split(/\r?\n/).includes("WEBHOOK_POST_RELEASE_AUDIT_STATE=absent"))
  assert.equal(readFileSync(f.archivePath, "utf8"), before)
  assertNoRedisOrWorkerMutation(readFileSync(f.callsPath, "utf8"), { requireRedisRead: true })
})

test("complete-postrelease rejects a foreign admission key before receipt or archive writes", (t) => {
  const f = fixture(t, { redisValue: "foreign-stop" })
  const before = readFileSync(f.receiptPath, "utf8")
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(f.receiptPath, "utf8"), before)
  assert.equal(existsSync(f.archivePath), false)
  assertNoRedisOrWorkerMutation(readFileSync(f.callsPath, "utf8"))
})

test("complete-postrelease rejects an already-present mismatched archive and preserves both receipts", (t) => {
  const f = fixture(t, { releaseStatus: "released" })
  const beforeActive = readFileSync(f.receiptPath, "utf8")
  const mismatched = {
    ...makeReceipt("released"),
    phase: "completed",
    recoveryCompleted: {
      ...makeReceipt("released").recoveryReleases[0],
      completedAt: "2026-10-07T00:00:04.000Z",
    },
  }
  mismatched.recoveryCandidates[0] = {
    ...mismatched.recoveryCandidates[0],
    workerImage: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"8".repeat(64)}`,
  }
  const beforeArchive = JSON.stringify(mismatched)
  writeFileSync(f.archivePath, beforeArchive, { mode: 0o600 })
  const result = f.run()
  assert.notEqual(result.status, 0)
  const activeAfter = JSON.parse(readFileSync(f.receiptPath, "utf8"))
  const activeBeforeReceipt = JSON.parse(beforeActive)
  for (const key of [
    "owner",
    "runId",
    "productRevision",
    "admissionStopValue",
    "attempts",
    "lastAttempt",
    "databaseUrlSha256",
    "databaseSystemUrlSha256",
    "redisUrlSha256",
    "recoveryCandidates",
    "recoveryReleases",
  ]) {
    assert.deepEqual(activeAfter[key], activeBeforeReceipt[key])
  }
  assert.equal(activeAfter.phase, "writers-stopped")
  assert.equal(activeAfter.recoveryFinalization.runId, finalizerRunId)
  assert.equal(readFileSync(f.archivePath, "utf8"), beforeArchive)
  assertNoRedisOrWorkerMutation(readFileSync(f.callsPath, "utf8"))
})

test("complete-postrelease rejects wrong finalizer bindings and failed runtime proof before archive", (t) => {
  for (const changes of [
    { finalizerRunId: recoveryRunId },
    { finalizerAttempt: "0" },
    { finalizerSource: "not-a-sha" },
    { workerImage: webImage },
    { env: { REDIS_VALUE: makeReceipt().admissionStopValue } },
    { env: { RUNTIME_PROOF_FAIL: "1" } },
  ]) {
    const f = fixture(t)
    const before = readFileSync(f.receiptPath, "utf8")
    const result = f.run(changes)
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(f.receiptPath, "utf8"), before)
    assert.equal(existsSync(f.archivePath), false)
    assertNoRedisOrWorkerMutation(readFileSync(f.callsPath, "utf8"))
  }
})
