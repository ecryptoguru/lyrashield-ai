import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const script = path.join(root, ".github/scripts/webhook-claims-vm.sh")
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

function releasedReceipt(status = "released") {
  const stop = JSON.stringify({
    operator: "github-actions",
    reason: "webhook-claims-cutover",
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
  })
  const release = {
    runId: recoveryRunId,
    attempt: Number(recoveryAttempt),
    sourceRevision: recoverySource,
    engineRevision,
    workerImage,
    protocol: "durable-claims/2",
    status,
    releasedAt: "2026-10-07T00:00:00.000Z",
  }
  const receipt = {
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
    admissionStopValue: stop,
    phase: "writers-stopped",
    attempts: [1, 2],
    lastAttempt: 2,
    previousWorkerImage: workerImage,
    recoveryCandidates: [
      {
        recoveryRunId,
        recoveryAttempt: Number(recoveryAttempt),
        sourceRevision: recoverySource,
        engineRevision,
        workerImage,
        protocol: "durable-claims/2",
      },
    ],
    recoveryReleases: [release],
    databaseUrlSha256: runtimeHashes.databaseUrlSha256,
    databaseSystemUrlSha256: runtimeHashes.databaseSystemUrlSha256,
    redisUrlSha256: runtimeHashes.redisUrlSha256,
  }
  if (status === "completed") {
    receipt.phase = "completed"
    receipt.recoveryCompleted = { ...release, completedAt: "2026-10-07T00:00:01.000Z" }
  }
  return receipt
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-postrelease-vm-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const receiptPath = path.join(directory, "webhook-claims-cutover.json")
  const archivePath = path.join(directory, `webhook-claims-cutover-completed-${originalRunId}.json`)
  const configPath = path.join(directory, "worker-runtime.conf")
  const environmentPath = path.join(directory, "worker.env")
  const envLibPath = path.join(directory, "worker-env.sh")
  const callsPath = path.join(directory, "calls.log")
  const receipt = releasedReceipt(options.releaseStatus ?? "released")
  const serializedReceipt = JSON.stringify(receipt)
  if (options.archiveOnly) {
    const archive = releasedReceipt("completed")
    writeFileSync(archivePath, JSON.stringify(archive), { mode: 0o600 })
  } else {
    writeFileSync(receiptPath, serializedReceipt, { mode: 0o600 })
  }
  const configuredImage = options.configuredImage ?? workerImage
  writeFileSync(
    configPath,
    `LYRASHIELD_WORKER_IMAGE=${configuredImage}\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/sandbox@sha256:${"9".repeat(64)}\n`
  )
  writeFileSync(environmentPath, "")
  writeFileSync(envLibPath, "lyrashield_worker_env_args() { :; }\n")
  writeFileSync(callsPath, "")

  executable(
    directory,
    "stat",
    `const args=process.argv.slice(2); if(args[0]==="-c"&&args[1]==="%u:%a"){console.log("0:600");process.exit(0)} process.exit(2);`
  )
  executable(
    directory,
    "docker",
    `
const fs=require("node:fs");
const args=process.argv.slice(2);
const log=${JSON.stringify(callsPath)};
fs.appendFileSync(log,"docker "+JSON.stringify(args)+"\\n");
if(args[0]==="image"&&args[1]==="inspect"){console.log(${JSON.stringify(engineRevision)});process.exit(0)}
if(args[0]==="inspect"){
 const format=args[args.indexOf("--format")+1]||"";
 if(format.includes("Health.Status")){console.log("healthy");process.exit(0)}
 if(format.includes("Config.Image")){console.log(process.env.CONFIGURED_IMAGE);process.exit(0)}
 process.exit(2)
}
if(args[0]==="exec"){
 const index=args.indexOf("printenv");
 if(index>=0){const names={LYRASHIELD_PRODUCT_REVISION:${JSON.stringify(recoverySource)},LYRASHIELD_ENGINE_REVISION:${JSON.stringify(engineRevision)},LYRASHIELD_WORKER_IMAGE_DIGEST:"sha256:${"c".repeat(64)}"};process.stdout.write(names[args[index+1]]||"");process.exit(0)}
 if(args.includes("node")){console.log(${JSON.stringify(JSON.stringify(runtimeHashes))});process.exit(0)}
 process.exit(2)
}
if(args[0]==="run"){
 const codeIndex=args.indexOf("-e"); if(codeIndex<0)process.exit(2);
 const code=args[codeIndex+1]||"";
 const raw=args[codeIndex+2]||"";
 const mode=args[codeIndex+3]||"";
 if(code.includes("Invalid recovery release state")||code.includes("Post-release receipt identity is invalid")){
  const value=JSON.parse(raw); const release=value.recoveryReleases?.at(-1);
  if(!release||!['release-intent','released'].includes(release.status)||release.runId!==${JSON.stringify(recoveryRunId)}||release.attempt!==Number(${JSON.stringify(recoveryAttempt)})||release.sourceRevision!==${JSON.stringify(recoverySource)}||release.engineRevision!==${JSON.stringify(engineRevision)}||release.workerImage!==process.env.CONFIGURED_IMAGE)process.exit(1);
  console.log(release.status);process.exit(0)
 }
 if(code.includes("Post-release finalization audit does not match")){
  const value=JSON.parse(raw);const audit=value.recoveryFinalization;
  if(audit===undefined){console.log("ABSENT");process.exit(0)}
  console.log(JSON.stringify(audit));process.exit(0)
 }
 if(code.includes("WEBHOOK_POST_RELEASE_AUDIT_STATE=present")){
  const audit=JSON.parse(raw);console.log("WEBHOOK_POST_RELEASE_AUDIT_STATE=present");console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_RUN_ID="+audit.runId);console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_ATTEMPT="+audit.attempt);console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_SOURCE_SHA="+audit.operationsSourceRevision);process.exit(0)
 }
 if(code.includes("const redis=new Redis")&&code.includes("Original admission stop changed")){
  const value=process.env.REDIS_VALUE||"null";
  if(value!=="null")process.exit(1);
  console.log("WITHOUT_ADMISSION_STOP");process.exit(0)
 }
 if(code.includes("assertWebhookRecoveryCandidate")&&code.includes("assertFullyMigratedWebhookSchema")&&code.includes("assertRuntimeRoleLeastPrivilege")){
  if(process.env.RUNTIME_PROOF_FAIL)process.exit(1);
  console.log("WEBHOOK_RECOVERY_RUNTIME_VERIFIED");process.exit(0)
 }
 process.exit(2)
}
process.exit(2);
`
  )
  executable(
    directory,
    "systemctl",
    `
const fs=require("node:fs");const args=process.argv.slice(2);const log=${JSON.stringify(callsPath)};
fs.appendFileSync(log,"systemctl "+args.join(" ")+"\\n");
const unit=args.at(-1);
if(args[0]==="is-active"){const value=unit.endsWith(".timer")?"active":"active";if(!args.includes("--quiet"))console.log(value);process.exit(0)}
if(args[0]==="is-enabled"){console.log("enabled");process.exit(0)}
process.exit(2);
`
  )

  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE: receiptPath,
    LYRASHIELD_WORKER_RUNTIME_CONFIG: configPath,
    LYRASHIELD_WORKER_ENV_FILE: environmentPath,
    LYRASHIELD_WORKER_ENV_LIB: envLibPath,
    CONFIGURED_IMAGE: configuredImage,
    REDIS_VALUE: options.redisValue ?? "null",
    RUNTIME_PROOF_FAIL: options.runtimeProofFail ? "1" : "",
    DATABASE_URL: databaseUrl,
    DATABASE_SYSTEM_URL: systemUrl,
    REDIS_URL: redisUrl,
    LYRASHIELD_PRODUCT_REVISION: recoverySource,
    LYRASHIELD_ENGINE_REVISION: engineRevision,
    LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  }

  function run(phase = "postrelease-probe", changes = {}) {
    const args = [
      script,
      phase,
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
      changes.preparedWorkerImage ?? workerImage,
      changes.preparedWebImage ?? webImage,
    ]
    return spawnSync("sh", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...(changes.env ?? {}) },
    })
  }
  return { run, callsPath, receiptPath, archivePath }
}

function assertReadOnlyCalls(calls) {
  for (const line of calls.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("systemctl ")) {
      assert.doesNotMatch(line, /^systemctl (start|stop|enable|disable)\b/)
    }
    if (line.startsWith("docker ")) {
      const args = JSON.parse(line.slice("docker ".length))
      assert.ok(!["start", "stop", "restart", "rm"].includes(args[0]))
      if (args[0] === "run") {
        const code = args[args.indexOf("-e") + 1] ?? ""
        assert.doesNotMatch(
          code,
          /redis\.set|redis\.call\(["']DEL|migrate deploy|prisma migrate deploy/i
        )
      }
    }
  }
}

test("postrelease probe accepts only an exact released or intent/null identity and leaves writer state unchanged", (t) => {
  for (const releaseStatus of ["released", "release-intent"]) {
    const f = fixture(t, { releaseStatus })
    const result = f.run()
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /^WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED$/m)
    assert.match(
      result.stdout,
      new RegExp(`^WEBHOOK_POST_RELEASE_RECEIPT_STATE=${releaseStatus}$`, "m")
    )
    assert.ok(
      result.stdout.split(/\r?\n/).includes(`WEBHOOK_POST_RELEASE_WORKER_IMAGE=${workerImage}`)
    )
    assert.ok(result.stdout.split(/\r?\n/).includes(`WEBHOOK_POST_RELEASE_WEB_IMAGE=${webImage}`))
    assertReadOnlyCalls(readFileSync(f.callsPath, "utf8"))
  }
})

test("postrelease probe rejects held or foreign Redis state, wrong image, and incomplete proof without mutation", (t) => {
  for (const options of [
    { redisValue: "held" },
    { redisValue: "foreign" },
    {
      configuredImage: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"9".repeat(64)}`,
    },
    { runtimeProofFail: true },
  ]) {
    const f = fixture(t, options)
    const result = f.run()
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /^WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED$/m)
    assertReadOnlyCalls(readFileSync(f.callsPath, "utf8"))
  }
})

test("postrelease probe rejects bad finalizer bindings before reaching runtime proof", (t) => {
  for (const changes of [
    { finalizerRunId: recoveryRunId },
    { finalizerAttempt: "0" },
    { finalizerSource: "not-a-sha" },
    { preparedWorkerImage: webImage },
  ]) {
    const f = fixture(t)
    const result = f.run("postrelease-probe", changes)
    assert.notEqual(result.status, 0)
    assert.equal(
      readFileSync(f.callsPath, "utf8").includes("WEBHOOK_RECOVERY_RUNTIME_VERIFIED"),
      false
    )
  }
})

test("archive-only postrelease probe proves a lost completion acknowledgement without mutation", (t) => {
  const f = fixture(t, { archiveOnly: true })
  const result = f.run()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_POST_RELEASE_RECEIPT_STATE=completed$/m)
  assertReadOnlyCalls(readFileSync(f.callsPath, "utf8"))
})
