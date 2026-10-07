import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const revision = "a".repeat(40)
const owner = "123:1"
const hash = (value = "") => createHash("sha256").update(value).digest("hex")
const databaseUrl = "postgresql://runtime:secret@db.example:6432/lyrashield?schema=public"
const systemUrl = "postgresql://system:other@db.example:6432/lyrashield?schema=public"
const redisUrl = "redis://fixture:secret@redis.example:6379"
const hashes = {
  databaseUrlSha256: hash(databaseUrl),
  databaseSystemUrlSha256: hash(systemUrl),
  redisUrlSha256: hash(redisUrl),
}
const image = `ghcr.io/example/worker:${"b".repeat(40)}@sha256:${"c".repeat(64)}`
function setup(t, scenario = "normal") {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-cutover-lifecycle-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const receipt = path.join(directory, "receipt.json")
  const stop = path.join(directory, "stop.json")
  const redis = path.join(directory, "redis.json")
  const otherRedis = path.join(directory, "other-redis.json")
  writeFileSync(otherRedis, "null")
  const state = path.join(directory, "state.json")
  const calls = path.join(directory, "calls")
  const config = path.join(directory, "config")
  writeFileSync(
    config,
    `LYRASHIELD_WORKER_IMAGE=${image}\nLYRASHIELD_SANDBOX_IMAGE=example@sha256:${"d".repeat(64)}\nLYRASHIELD_SANDBOX_NETWORK=sandbox\n`
  )
  writeFileSync(
    state,
    JSON.stringify({
      worker: "active",
      timer: "active",
      enabled: "enabled",
      workerEnabled: "enabled",
      container: true,
      active: 2,
      replicas: 0,
    })
  )
  writeFileSync(redis, scenario === "foreign stop" ? JSON.stringify("foreign") : "null")
  writeFileSync(calls, "")
  const executable = (name, body) => {
    const file = path.join(directory, name)
    writeFileSync(
      file,
      `#!${process.execPath}\nconst fs=require("node:fs"); const statePath=${JSON.stringify(state)}; const calls=${JSON.stringify(calls)}; const state=JSON.parse(fs.readFileSync(statePath)); const args=process.argv.slice(2); fs.appendFileSync(calls,${JSON.stringify(name)}+" "+args.join(" ")+"\\n");\n${body}`
    )
    chmodSync(file, 0o755)
  }
  const db = path.join(directory, "db.mjs")
  writeFileSync(
    db,
    `export const getSystemPrisma=()=>({scan:{count:async()=>process.env.TEST_RACE_SCAN==="1"?1:${scenario === "active scan" ? 1 : 0}},$queryRaw:async(sql)=>{if(${JSON.stringify(scenario)}==="legacy query unavailable")throw new Error("database unavailable");return [{count:sql[0].includes("WHERE status")?(process.env.TEST_RACE_TRACK==="1"?1:${scenario === "nonterminal track" ? 1 : 0}):sql[0].includes("information_schema")?${scenario === "UTC installed" ? 2 : scenario === "partial UTC schema" ? 1 : 0}:(process.env.TEST_RACE_SCHEDULE==="1"?1:${scenario === "legacy scheduled" || scenario === "UTC installed" ? 1 : 0})}]},$disconnect:async()=>{}})`
  )
  const integration = path.join(directory, "integrations.mjs")
  writeFileSync(
    integration,
    `const queue=()=>({getJobCounts:async(...states)=>Object.fromEntries(states.map(name=>[name,(name==="wait"&&${scenario === "retry pending"})||(name==="paused"&&${scenario === "paused jobs"})||(name==="waiting-children"&&${scenario === "waiting children"})?1:0])),close:async()=>{}});export const getScanQueue=queue,getWebhookTrackRetryQueue=queue,closeRedis=async()=>{}`
  )
  const billing = path.join(directory, "billing.mjs")
  writeFileSync(
    billing,
    `export const WEBHOOK_TRACK_CLAIM_PROTOCOL=${JSON.stringify(scenario === "old candidate" ? "legacy" : "durable-claims/2")}`
  )
  const redisModule = path.join(directory, "redis.mjs")
  writeFileSync(
    redisModule,
    `import fs from 'node:fs';import {createHash} from 'node:crypto';const file=createHash('sha256').update(process.env.REDIS_URL??'').digest('hex')===${JSON.stringify(hashes.redisUrlSha256)}?${JSON.stringify(redis)}:${JSON.stringify(otherRedis)};export default class Redis {async get(){return JSON.parse(fs.readFileSync(file))} async set(k,v){if(await this.get()!==null)return null;fs.writeFileSync(file,JSON.stringify(v));return 'OK'}async ["eval"](code,n,k,v){if(await this.get()!==v)return 0;fs.writeFileSync(file,'null');return 1}async quit(){}}`
  )
  executable(
    "docker",
    `const {spawnSync}=require("node:child_process"); if(args[0]==="ps"){if(state.container)console.log("lyrashield-worker");}else if(args[0]==="image"){const format=args[args.indexOf("--format")+1];console.log(format.includes("io.lyrashield.engine.revision")?${JSON.stringify("d".repeat(40))}:format.includes("engine.revision")?"":args.at(-1).match(/:([a-f0-9]{40})@/)?.[1]??${JSON.stringify("b".repeat(40))});}else if(args[0]==="container" || args[0]==="inspect"){if(!state.container)process.exit(1);console.log(args.includes("{{.Config.Image}}")?${JSON.stringify(image)}:"true");}else if(args[0]==="run" || args[0]==="exec"){let code=args[args.indexOf("-e")+1]; if(code.includes("assertWebhookCutoverWorkerIdentity")){const values=args.flatMap((arg,i)=>arg==="--env" && args[i+1]?.startsWith("TMPDIR=")?[args[i+1]]:[]); if(values.at(-1)!=="TMPDIR=/tmp" || !args.includes("/tmp:rw,nosuid,nodev,noexec,size=64m"))process.exit(13);} for(const [from,to] of ${JSON.stringify(
      [
        ["@lyrashield/db", db],
        ["@lyrashield/integrations", integration],
        ["@lyrashield/billing", billing],
        [
          "file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs",
          path.join(root, "ops/worker/webhook-cutover-recovery.mjs"),
        ],
        ["ioredis", redisModule],
      ]
    )}) code=code.replaceAll('"'+from+'"',JSON.stringify(to)); const result=spawnSync(process.execPath,["--input-type=module","-e",code,...args.slice(args.indexOf("-e")+2)],{encoding:"utf8",env:{...process.env,LYRASHIELD_PRODUCT_REVISION:${JSON.stringify(revision)},...(args[0]==="run" && ${JSON.stringify(scenario)}==="stale environment"?{REDIS_URL:"different"}:{})}}); process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status);}else process.exit(1);`
  )
  executable(
    "systemctl",
    `const name=args.at(-1);if(args[0]==="is-active"){const value=name==="lyrashield-worker.service"?state.worker:name.endsWith(".timer")?state.timer:"inactive";if(!args.includes("--quiet"))console.log(value);process.exit(value==="active"?0:3);}else if(args[0]==="is-enabled"){const value=name.endsWith(".timer")?state.enabled:state.workerEnabled;console.log(value);process.exit(value==="enabled"?0:1);}else if(args[0]==="disable"){if(name.endsWith(".timer")){state.enabled="disabled";state.timer="inactive";}else{state.workerEnabled="disabled";state.worker="inactive";state.container=false;fs.writeFileSync(${JSON.stringify(stop)},JSON.stringify({imageReference:${JSON.stringify(image)},...${JSON.stringify(hashes)}}),{mode:0o600});}}else if(args[0]==="enable"){state.enabled="enabled";state.timer="active";}else if(args[0]==="stop" && name==="lyrashield-worker.service"){state.worker="inactive";state.container=false;fs.writeFileSync(${JSON.stringify(stop)},JSON.stringify({imageReference:${JSON.stringify(image)},...${JSON.stringify(hashes)}}),{mode:0o600});}fs.writeFileSync(statePath,JSON.stringify(state));`
  )
  executable(
    "stat",
    `const file=args.at(-1); const value=fs.statSync(file);console.log(args[1]==="%u:%a"?"0:"+(value.mode&511).toString(8):Math.floor(value.mtimeMs/1000));`
  )
  executable("sleep", "process.exit(0)")
  executable(
    "timeout",
    `const {spawnSync}=require("node:child_process"); const result=spawnSync(args[2],args.slice(3),{encoding:"utf8",env:process.env});process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");process.exit(result.status??1);`
  )
  executable(
    "az",
    `const {spawnSync}=require("node:child_process"); if(args[0]==="vm"){let code=args[args.indexOf("--scripts")+1].replaceAll("/var/lib/lyrashield",${JSON.stringify(directory)});const result=spawnSync("bash",["-c",code],{encoding:"utf8",env:process.env});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status);}else if(args.includes("deactivate")){state.active=0;fs.writeFileSync(statePath,JSON.stringify(state));}else if(args.includes("replica")){console.log(${scenario === "old replica" ? 1 : 0});}else if(args.some(arg=>arg.includes("length(@)"))){console.log(state.active);}else {console.log(state.active?"old-a\\nold-b":"old-a\\nold-b");}`
  )
  const envFile = path.join(directory, "env-helper")
  writeFileSync(envFile, "lyrashield_worker_env_args() { :; }\n")
  const githubEnv = path.join(directory, "github-env")
  writeFileSync(githubEnv, "")
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    LYRASHIELD_WORKER_RUNTIME_CONFIG: config,
    LYRASHIELD_WORKER_ENV_FILE: config,
    LYRASHIELD_WORKER_ENV_LIB: envFile,
    LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE: receipt,
    LYRASHIELD_WORKER_STOP_RECEIPT_FILE: stop,
    DATABASE_URL: databaseUrl,
    DATABASE_SYSTEM_URL: systemUrl,
    REDIS_URL: redisUrl,
    GITHUB_ENV: githubEnv,
    DEPLOY_SHA: revision,
    RG: "group",
    APP_NAME: "app",
    SCANNER_NAME: "scanner",
    WORKER_VM_NAME: "worker",
    LYRASHIELD_ADMISSION_STOP_OWNER: owner,
    LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID: "123",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "1",
  }
  const vm = (phase, overrides = {}) =>
    spawnSync(
      "sh",
      [
        path.join(root, ".github/scripts/webhook-claims-vm.sh"),
        phase,
        revision,
        overrides.TEST_OWNER ?? owner,
        overrides.TEST_RUN_ID ?? "123",
        overrides.MIGRATION_DATABASE_IDENTITY ?? "",
        overrides.TEST_ATTEMPT ?? overrides.LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT ?? "1",
      ],
      { encoding: "utf8", env: { ...env, ...overrides } }
    )
  const local = (phase, overrides = {}) =>
    spawnSync("bash", [path.join(root, ".github/scripts/webhook-claims-maintenance.sh"), phase], {
      encoding: "utf8",
      env: { ...env, ...overrides },
    })
  return { vm, local, env, receipt, redis, otherRedis, state, calls }
}

test("real lifecycle shell claims, excludes ingress, stops worker, verifies and resumes only owned compatible baseline", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const saved = JSON.parse(readFileSync(f.receipt))
  assert.equal(saved.runId, "123")
  const quiesced = f.local("quiesce")
  assert.equal(quiesced.status, 0, quiesced.stderr)
  assert.equal(f.vm("verify").status, 0)
  const state = JSON.parse(readFileSync(f.state))
  state.worker = "active"
  state.container = true
  writeFileSync(f.state, JSON.stringify(state))
  const resumed = f.vm("resume")
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.equal(JSON.parse(readFileSync(f.redis)), null)
})
for (const scenario of [
  "foreign stop",
  "active scan",
  "retry pending",
  "paused jobs",
  "waiting children",
  "old replica",
  "stale environment",
]) {
  test(`maintenance fails closed without stopping paid work: ${scenario}`, (t) => {
    const f = setup(t, scenario)
    const claimed = f.vm("claim")
    if (
      [
        "stale environment",
        "active scan",
        "retry pending",
        "paused jobs",
        "waiting children",
      ].includes(scenario)
    ) {
      assert.notEqual(claimed.status, 0)
      assert.equal(JSON.parse(readFileSync(f.redis)), null)
      return
    }
    if (scenario === "foreign stop") {
      assert.notEqual(claimed.status, 0)
      assert.equal(JSON.parse(readFileSync(f.redis)), "foreign")
      return
    }
    assert.equal(claimed.status, 0, claimed.stderr)
    assert.notEqual(f.local("quiesce").status, 0)
    assert.equal(JSON.parse(readFileSync(f.state)).worker, "active")
    assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
  })
}
test("foreign receipt owner cannot verify or resume", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const saved = JSON.parse(readFileSync(f.receipt))
  saved.owner = "999:1"
  writeFileSync(f.receipt, JSON.stringify(saved), { mode: 0o600 })
  assert.notEqual(f.vm("verify").status, 0)
  assert.notEqual(f.vm("resume").status, 0)
  assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
})
test("failure hold never activates a legacy revision or resumes admission", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const held = f.local("hold")
  assert.equal(held.status, 0, held.stderr)
  const calls = readFileSync(f.calls, "utf8")
  assert.doesNotMatch(calls, /revision activate|systemctl enable|redis.call.*DEL/)
  assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
})

test("candidate with legacy billing protocol cannot resume an owned stop", (t) => {
  const f = setup(t, "old candidate")
  assert.equal(f.vm("claim").status, 0)
  assert.equal(f.local("quiesce").status, 0)
  const state = JSON.parse(readFileSync(f.state))
  state.worker = "active"
  state.container = true
  writeFileSync(f.state, JSON.stringify(state))
  assert.notEqual(f.vm("resume").status, 0)
  assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
})

test("tampered database identity cannot verify or resume the receipt", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const receipt = JSON.parse(readFileSync(f.receipt))
  receipt.redisUrlSha256 = "0".repeat(64)
  writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
  assert.notEqual(f.vm("verify").status, 0)
  assert.notEqual(f.vm("resume").status, 0)
  assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
})

test("launch checks refreshed secrets before any worker queue consumer starts", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const saved = JSON.parse(readFileSync(f.receipt))
  Object.assign(saved, {
    candidateWorkerImage: image,
    candidateProductRevision: revision,
    candidateEngineRevision: "d".repeat(40),
    candidateWebhookTrackClaimProtocol: "durable-claims/2",
  })
  writeFileSync(f.receipt, JSON.stringify(saved), { mode: 0o600 })
  const source = readFileSync("ops/worker/run-worker.sh", "utf8")
  const start = source.indexOf("cutover_receipt=${")
  const end = source.indexOf("\nsocket_group=", start)
  assert.ok(start > 0 && end > start)
  assert.ok(end < source.indexOf("docker create"))
  const block = source.slice(start, end)
  assert.match(block, /WEBHOOK_TRACK_CLAIM_PROTOCOL!=="durable-claims\/2"/)
  const run = (overrides = {}) =>
    spawnSync(
      "sh",
      [
        "-eu",
        "-c",
        `environment_file="$LYRASHIELD_WORKER_ENV_FILE"; env_args="--env TMPDIR=/var/lib/lyrashield/worker/tmp"; ${block}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...f.env,
          LYRASHIELD_WORKER_IMAGE: image,
          LYRASHIELD_ENGINE_REVISION: "d".repeat(40),
          LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
          ...overrides,
        },
      }
    )
  const launched = run()
  assert.equal(launched.status, 0, launched.stderr)
  assert.notEqual(run({ REDIS_URL: "rotated-endpoint" }).status, 0)
})

test("retained compatible candidate uses the image engine label during claim recovery", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  assert.equal(f.local("quiesce").status, 0)
  const candidate = `ghcr.io/example/worker:${revision}@sha256:${"e".repeat(64)}`
  const receipt = JSON.parse(readFileSync(f.receipt))
  Object.assign(receipt, {
    candidateWorkerImage: candidate,
    candidateProductRevision: revision,
    candidateEngineRevision: "d".repeat(40),
    candidateWebhookTrackClaimProtocol: "durable-claims/2",
  })
  writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(
    f.env.LYRASHIELD_WORKER_RUNTIME_CONFIG,
    readFileSync(f.env.LYRASHIELD_WORKER_RUNTIME_CONFIG, "utf8").replace(image, candidate)
  )
  const result = f.vm("claim", { TEST_OWNER: "123:2", TEST_ATTEMPT: "2" })
  assert.equal(result.status, 0, result.stderr)
})

test("same GitHub run rerun preserves the original nonce and owner after stopping writers", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const original = readFileSync(f.redis, "utf8")
  assert.equal(f.local("quiesce").status, 0)
  const recovered = f.vm("claim", { TEST_OWNER: "123:2", TEST_ATTEMPT: "2" })
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.match(recovered.stdout, /ADMISSION_STOP_OWNER=123:1/)
  assert.equal(readFileSync(f.redis, "utf8"), original)
  assert.equal(f.vm("stop").status, 0)
})

test("attempt 2 stays distinct from immutable receipt owner through failed-maintenance hold", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const originalStop = readFileSync(f.redis, "utf8")
  assert.equal(f.local("quiesce").status, 0)

  const retryEnv = {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  }
  const probe = f.local("recovery-probe", retryEnv)
  assert.equal(probe.status, 0, probe.stderr)
  const reclaimed = f.local("claim", retryEnv)
  assert.equal(reclaimed.status, 0, reclaimed.stderr)
  const currentReceipt = JSON.parse(readFileSync(f.receipt))
  assert.equal(currentReceipt.owner, "123:1")
  assert.deepEqual(currentReceipt.attempts, [1, 2])
  assert.equal(currentReceipt.lastAttempt, 2)
  assert.equal(readFileSync(f.redis, "utf8"), originalStop)

  // GITHUB_ENV carries the original receipt owner into later steps. The
  // independent workflow-attempt value must stay 2 so a later hold cannot
  // roll receipt history backward to the owner suffix 1.
  const held = f.local("hold", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:1",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.equal(held.status, 0, held.stderr)
  const heldReceipt = JSON.parse(readFileSync(f.receipt))
  assert.equal(heldReceipt.owner, "123:1")
  assert.deepEqual(heldReceipt.attempts, [1, 2])
  assert.equal(heldReceipt.lastAttempt, 2)
  assert.equal(readFileSync(f.redis, "utf8"), originalStop)
  assert.equal(JSON.parse(readFileSync(f.state)).active, 0)
})

test("retry receipt probe distinguishes verified ownership from truly absent state", (t) => {
  const empty = setup(t)
  const absent = empty.local("recovery-probe", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.equal(absent.status, 0, absent.stderr)
  assert.match(absent.stdout, /WEBHOOK_RECOVERY_RECEIPT_ABSENT/)
  assert.equal(JSON.parse(readFileSync(empty.redis)), null)

  const owned = setup(t)
  assert.equal(owned.vm("claim").status, 0)
  const verified = owned.local("recovery-probe", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /WEBHOOK_RECOVERY_RECEIPT_VERIFIED/)

  const intent = setup(t)
  assert.equal(intent.vm("claim").status, 0)
  const intentReceipt = JSON.parse(readFileSync(intent.receipt))
  intentReceipt.phase = "intent"
  writeFileSync(intent.receipt, JSON.stringify(intentReceipt), { mode: 0o600 })
  writeFileSync(intent.redis, "null")
  const intentProbe = intent.local("recovery-probe", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.equal(intentProbe.status, 0, intentProbe.stderr)
  assert.match(intentProbe.stdout, /WEBHOOK_RECOVERY_RECEIPT_VERIFIED/)
  assert.equal(
    JSON.parse(readFileSync(intent.redis)),
    null,
    "the recovery probe must remain read-only"
  )

  const foreignStop = setup(t, "foreign stop")
  const ambiguous = foreignStop.local("recovery-probe", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.notEqual(ambiguous.status, 0)
  assert.doesNotMatch(ambiguous.stdout, /WEBHOOK_RECOVERY_RECEIPT_ABSENT/)
})

test("retry probe rejects receipts whose latest owner attempt is not earlier than this attempt", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const receipt = JSON.parse(readFileSync(f.receipt))
  receipt.lastAttempt = 2
  receipt.attempts = [1, 2]
  writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
  const probe = f.local("recovery-probe", {
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
  })
  assert.notEqual(probe.status, 0)
  assert.doesNotMatch(probe.stdout, /WEBHOOK_RECOVERY_RECEIPT_VERIFIED/)
})

test("retry probe rejects duplicate or out-of-order attempt history", (t) => {
  for (const attempts of [
    [1, 1],
    [2, 1],
  ]) {
    const f = setup(t)
    assert.equal(f.vm("claim").status, 0)
    const receipt = JSON.parse(readFileSync(f.receipt))
    receipt.lastAttempt = Math.max(...attempts)
    receipt.attempts = attempts
    writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
    const probe = f.local("recovery-probe", {
      LYRASHIELD_ADMISSION_STOP_OWNER: "123:3",
      LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "3",
    })
    assert.notEqual(probe.status, 0)
    assert.doesNotMatch(probe.stdout, /WEBHOOK_RECOVERY_RECEIPT_VERIFIED/)
  }
})

test("failure hold only closes ingress after recovering this run's owned claim", (t) => {
  const partial = setup(t)
  const noReceiptHold = partial.local("hold")
  assert.notEqual(noReceiptHold.status, 0)
  assert.equal(JSON.parse(readFileSync(partial.state)).active, 2)
  assert.equal(JSON.parse(readFileSync(partial.redis)), null)

  const interrupted = setup(t)
  assert.equal(interrupted.vm("claim").status, 0)
  const receipt = JSON.parse(readFileSync(interrupted.receipt))
  receipt.phase = "intent"
  writeFileSync(interrupted.receipt, JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(interrupted.redis, JSON.stringify(receipt.admissionStopValue))
  const held = interrupted.local("hold")
  assert.equal(held.status, 0, held.stderr)
  assert.equal(JSON.parse(readFileSync(interrupted.state)).active, 0)
  assert.equal(JSON.parse(readFileSync(interrupted.redis)), receipt.admissionStopValue)
  const calls = readFileSync(interrupted.calls, "utf8")
  assert.ok(calls.indexOf("recovery") < calls.indexOf("deactivate"))

  const beforeRedisSet = setup(t)
  assert.equal(beforeRedisSet.vm("claim").status, 0)
  const intent = JSON.parse(readFileSync(beforeRedisSet.receipt))
  intent.phase = "intent"
  writeFileSync(beforeRedisSet.receipt, JSON.stringify(intent), { mode: 0o600 })
  writeFileSync(beforeRedisSet.redis, "null")
  const repairedAndHeld = beforeRedisSet.local("hold")
  assert.equal(repairedAndHeld.status, 0, repairedAndHeld.stderr)
  assert.equal(JSON.parse(readFileSync(beforeRedisSet.redis)), intent.admissionStopValue)
  assert.equal(JSON.parse(readFileSync(beforeRedisSet.state)).active, 0)

  const foreignReceipt = setup(t)
  assert.equal(foreignReceipt.vm("claim").status, 0)
  const tampered = JSON.parse(readFileSync(foreignReceipt.receipt))
  tampered.owner = "999:1"
  writeFileSync(foreignReceipt.receipt, JSON.stringify(tampered), { mode: 0o600 })
  assert.notEqual(foreignReceipt.local("hold").status, 0)
  assert.equal(JSON.parse(readFileSync(foreignReceipt.state)).active, 2)
  assert.notEqual(JSON.parse(readFileSync(foreignReceipt.redis)), null)
})

test("a separate dispatch cannot adopt another run's held receipt", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const recovered = f.vm("claim", { TEST_OWNER: "456:1", TEST_RUN_ID: "456" })
  assert.notEqual(recovered.status, 0)
  assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
})

test("intent persisted before Redis SET is recoverable by the same run without a new nonce", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const receipt = JSON.parse(readFileSync(f.receipt))
  receipt.phase = "intent"
  writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(f.redis, "null")
  const recovered = f.vm("claim", { TEST_OWNER: "123:2", TEST_ATTEMPT: "2" })
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(JSON.parse(readFileSync(f.redis)), receipt.admissionStopValue)
  assert.deepEqual(JSON.parse(readFileSync(f.receipt)).attempts, [1, 2])
})

test("failure hold after an uncertain admission DEL restores the exact owned stop before closing apps", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const receipt = JSON.parse(readFileSync(f.receipt))
  receipt.phase = "resuming"
  writeFileSync(f.receipt, JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(f.redis, "null")
  const held = f.local("hold")
  assert.equal(held.status, 0, held.stderr)
  assert.equal(JSON.parse(readFileSync(f.redis)), receipt.admissionStopValue)
  assert.equal(JSON.parse(readFileSync(f.state)).active, 0)
})

test("recovery against a changed Redis connection mutates neither deployment", (t) => {
  const f = setup(t)
  assert.equal(f.vm("claim").status, 0)
  const before = readFileSync(f.redis, "utf8")
  const recovered = f.vm("claim", {
    TEST_OWNER: "123:2",
    TEST_ATTEMPT: "2",
    REDIS_URL: "rotated-endpoint",
  })
  assert.notEqual(recovered.status, 0)
  assert.equal(readFileSync(f.redis, "utf8"), before)
  assert.equal(JSON.parse(readFileSync(f.otherRedis)), null)
})

test("original source recovery requires an existing immutable receipt before any configuration mutation", (t) => {
  const f = setup(t)
  assert.notEqual(f.vm("recovery").status, 0)
  assert.equal(f.vm("claim").status, 0)
  assert.equal(f.vm("recovery", { TEST_OWNER: "123:2", TEST_ATTEMPT: "2" }).status, 0)
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  assert.ok(
    runtime.indexOf("- name: Revalidate retry state for an automatic first cutover") <
      runtime.indexOf("- name: Ensure app and scanner system identities")
  )
})

test("migration database identity accepts different roles and ports before claim, rejects another database without mutation", (t) => {
  const fixture = setup(t)
  const identity = hash(JSON.stringify(["db.example", "lyrashield", "public"]))
  const verified = fixture.vm("database", { MIGRATION_DATABASE_IDENTITY: identity })
  assert.equal(verified.status, 0, verified.stderr)
  assert.notEqual(
    fixture.vm("database", {
      MIGRATION_DATABASE_IDENTITY: hash(JSON.stringify(["other.example", "lyrashield", "public"])),
    }).status,
    0
  )
  assert.equal(readFileSync(fixture.redis, "utf8"), "null")
})

for (const [scenario, succeeds] of [
  ["legacy scheduled", false],
  ["partial UTC schema", false],
  ["legacy query unavailable", false],
  ["UTC installed", true],
]) {
  test(`first UTC migration checks actual drained scheduling data: ${scenario}`, (t) => {
    const f = setup(t, scenario)
    const claimed = f.vm("claim")
    if (!succeeds) {
      assert.notEqual(claimed.status, 0)
      assert.equal(JSON.parse(readFileSync(f.redis)), null)
      assert.equal(existsSync(f.receipt), false)
      assert.equal(JSON.parse(readFileSync(f.state)).active, 2)
      assert.equal(JSON.parse(readFileSync(f.state)).worker, "active")
      return
    }
    assert.equal(claimed.status, 0, claimed.stderr)
    const quiesced = f.local("quiesce")
    const verified = quiesced.status === 0 ? f.vm("verify") : quiesced
    assert.equal(verified.status === 0, succeeds, verified.stderr)
    if (!succeeds) {
      assert.notEqual(JSON.parse(readFileSync(f.redis)), null, "maintenance stays held")
      assert.equal(JSON.parse(readFileSync(f.state)).worker, "inactive")
    }
  })
}

for (const scenario of [
  "active scan",
  "retry pending",
  "paused jobs",
  "waiting children",
  "nonterminal track",
  "legacy scheduled",
  "legacy query unavailable",
  "partial UTC schema",
]) {
  test(`busy or unreadable baseline cannot claim or pause writers: ${scenario}`, (t) => {
    const f = setup(t, scenario)
    assert.notEqual(f.local("claim").status, 0)
    assert.equal(existsSync(f.receipt), false)
    assert.equal(JSON.parse(readFileSync(f.redis)), null)
    assert.notEqual(f.local("hold").status, 0)
    const state = JSON.parse(readFileSync(f.state))
    assert.equal(state.active, 2)
    assert.equal(state.worker, "active")
    assert.equal(state.timer, "active")
    assert.doesNotMatch(
      readFileSync(f.calls, "utf8"),
      /systemctl (stop|disable)|revision deactivate/
    )
  })
}
for (const race of ["TEST_RACE_SCAN", "TEST_RACE_TRACK", "TEST_RACE_SCHEDULE"]) {
  test(`post-eligibility race remains fenced: ${race}`, (t) => {
    const f = setup(t)
    assert.equal(f.local("claim").status, 0)
    assert.notEqual(f.local("quiesce", { [race]: "1" }).status, 0)
    assert.notEqual(JSON.parse(readFileSync(f.redis)), null)
    const state = JSON.parse(readFileSync(f.state))
    assert.equal(state.worker, "active")
    assert.equal(state.container, true)
    assert.equal(state.timer, "active")
    assert.doesNotMatch(readFileSync(f.calls, "utf8"), /systemctl (stop|disable)/)
    assert.equal(f.local("hold").status, 0)
    assert.equal(JSON.parse(readFileSync(f.state)).active, 0)
  })
}

for (const archived of [false, true]) {
  test(`completed cutover cannot re-enter maintenance on a reusable-job retry (archived=${archived})`, (t) => {
    const f = setup(t)
    assert.equal(f.vm("claim").status, 0)
    const receipt = JSON.parse(readFileSync(f.receipt))
    receipt.phase = "completed"
    const file = archived
      ? path.join(path.dirname(f.receipt), "webhook-claims-cutover-completed-123.json")
      : f.receipt
    writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 })
    if (archived) rmSync(f.receipt)
    writeFileSync(f.redis, "null")
    const before = readFileSync(f.state, "utf8")
    for (const phase of ["recovery-probe", "recovery", "claim", "hold"]) {
      const result = f.local(phase, {
        LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
        LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "2",
      })
      assert.notEqual(result.status, 0, phase)
      assert.match(result.stderr, /Completed cutover cannot re-enter maintenance/)
      assert.equal(JSON.parse(readFileSync(f.redis)), null)
      assert.equal(readFileSync(f.state, "utf8"), before)
      assert.equal(readFileSync(file, "utf8"), JSON.stringify(receipt))
    }
    if (archived) assert.equal(existsSync(f.receipt), false)
    assert.doesNotMatch(
      readFileSync(f.calls, "utf8"),
      /systemctl (stop|disable)|revision deactivate/
    )
  })
}
