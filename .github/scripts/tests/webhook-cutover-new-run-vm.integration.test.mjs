import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { assertWebhookCutoverWorkerIdentity } from "../../../ops/worker/webhook-cutover-recovery.mjs"
import {
  WEBHOOK_CUTOVER_MIGRATION_CHECKSUMS,
  WEBHOOK_CUTOVER_MIGRATION_NAMES,
} from "../../../ops/worker/webhook-cutover-schema.mjs"

const root = process.cwd()
const script = path.join(root, ".github/scripts/webhook-claims-vm.sh")
const maintenanceScript = path.join(root, ".github/scripts/webhook-claims-maintenance.sh")
const originalRunId = "37516632066"
const originalOwner = `${originalRunId}:1`
const originalSource = "a".repeat(40)
const recoveryRunId = "37520000000"
const recoveryOwner = `${recoveryRunId}:1`
const recoverySource = "b".repeat(40)
const currentImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:${recoverySource}@sha256:${"c".repeat(64)}`
const currentWebImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"e".repeat(64)}`
const databaseUrl = "postgresql://worker:fixture@db.example:6432/lyrashield?schema=public"
const systemUrl = "postgresql://system:fixture@db.example:6432/lyrashield?schema=public"
const redisUrl = "rediss://fixture:fixture@redis.example:6379/0"
const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function heldReceipt() {
  const admissionStopValue = JSON.stringify({
    operator: "github-actions",
    reason: "webhook-claims-cutover",
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
  })
  return {
    owner: originalOwner,
    runId: originalRunId,
    productRevision: originalSource,
    admissionStopValue,
    phase: "writers-stopped",
    attempts: [1, 2],
    lastAttempt: 2,
    previousWorkerImage: currentImage,
    candidateWorkerImage: currentImage,
    candidateProductRevision: originalSource,
    candidateEngineRevision: "d".repeat(40),
    candidateWebhookTrackClaimProtocol: "durable-claims/2",
    recoveryCandidates: [
      {
        recoveryRunId,
        recoveryAttempt: 1,
        sourceRevision: recoverySource,
        engineRevision: "d".repeat(40),
        workerImage: currentImage,
        protocol: "durable-claims/2",
      },
    ],
    databaseUrlSha256: sha256(databaseUrl),
    databaseSystemUrlSha256: sha256(systemUrl),
    redisUrlSha256: sha256(redisUrl),
  }
}

function executable(directory, name, body) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!${process.execPath}\n${body}`)
  chmodSync(file, 0o755)
  return file
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-held-cutover-vm-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const receiptPath = path.join(directory, "webhook-claims-cutover.json")
  const configPath = path.join(directory, "worker-runtime.conf")
  const environmentPath = path.join(directory, "worker.env")
  const envLibPath = path.join(directory, "worker-env.sh")
  const redisPath = path.join(directory, "redis.json")
  const statePath = path.join(directory, "state.json")
  const revisionsPath = path.join(directory, "revisions.json")
  const callsPath = path.join(directory, "calls.log")
  const actionLogPath = path.join(directory, "redis-actions.log")
  const githubEnvPath = path.join(directory, "github-env.txt")
  const dbModule = path.join(directory, "db.mjs")
  const integrationsModule = path.join(directory, "integrations.mjs")
  const redisModule = path.join(directory, "redis.mjs")
  const billingModule = path.join(directory, "billing.mjs")

  const receipt = { ...heldReceipt(), ...(options.receipt ?? {}) }
  if (options.receiptPresent !== false)
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  writeFileSync(
    configPath,
    `LYRASHIELD_WORKER_IMAGE=${currentImage}\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/sandbox:fixture@sha256:${"f".repeat(64)}\n`
  )
  writeFileSync(environmentPath, "")
  writeFileSync(envLibPath, "lyrashield_worker_env_args() { :; }\n")
  writeFileSync(
    redisPath,
    JSON.stringify(
      Object.hasOwn(options, "redisValue") ? options.redisValue : receipt.admissionStopValue
    )
  )
  writeFileSync(callsPath, "")
  writeFileSync(actionLogPath, "")
  writeFileSync(githubEnvPath, "")
  writeFileSync(
    statePath,
    JSON.stringify({
      worker: options.workerState ?? "failed",
      workerEnabled: options.workerEnabled ?? "disabled",
      timer: options.timerState ?? "inactive",
      timerEnabled: options.timerEnabled ?? "disabled",
      egress: options.egressState ?? "inactive",
      container: options.containerPresent ?? false,
      nonterminalScans: options.nonterminalScans ?? 0,
      nonterminalTracks: options.nonterminalTracks ?? 0,
      utcColumns: options.utcColumns ?? 2,
      legacySchedule: options.legacySchedule ?? 0,
      queue: options.queue ?? "",
      queueState: options.queueState ?? "",
      publicReadinessFailures: options.publicReadinessFailures ?? [],
      failCompletedReproof: options.failCompletedReproof ?? false,
      completedVerifyCalls: 0,
    })
  )
  writeFileSync(
    revisionsPath,
    JSON.stringify({
      app: [{ name: "lyrashield-app--old", active: true }],
      scanner: [{ name: "lyrashield-scanner--old", active: true }],
      residualReplicas: options.residualReplicas ?? 0,
    })
  )

  const migratedColumns = [
    ["id", "text", true, null],
    ["webhookEventId", "text", true, null],
    ["workspaceId", "text", false, null],
    ["track", "text", true, null],
    ["status", "text", true, "'pending'::text"],
    ["attempts", "integer", true, "0"],
    ["lastError", "text", false, null],
    ["completedAt", "timestamp(3) without time zone", false, null],
    ["createdAt", "timestamp(3) without time zone", true, "CURRENT_TIMESTAMP"],
    ["updatedAt", "timestamp(3) without time zone", true, null],
    ["generation", "integer", true, "0"],
    ["nextAttemptAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
    ["claimToken", "text", false, null],
    ["leaseExpiresAt", "timestamp(3) without time zone", false, null],
    ["nextAttemptAtUtc", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["leaseExpiresAtUtc", "timestamp(3) with time zone", false, null],
    ["historicalAttempts", "integer", true, "0"],
    ["operatorRecoveryCount", "integer", true, "0"],
  ].map(([name, type, notNull, defaultExpr]) => ({ name, type, notNull, defaultExpr }))
  const migratedConstraints = [
    {
      name: "WebhookEventTrack_pkey",
      type: "p",
      definition: "primary key (id)",
      validated: true,
    },
    {
      name: "WebhookEventTrack_webhookEventId_fkey",
      type: "f",
      definition:
        'foreign key ("webhookEventId") references "WebhookEvent"(id) on update cascade on delete cascade',
      validated: true,
    },
    {
      name: "WebhookEventTrack_generation_nonnegative",
      type: "c",
      definition: "check (generation >= 0)",
      validated: true,
    },
  ]
  const migratedIndexes = [
    ["WebhookEventTrack_pkey", ["id"], true],
    ["WebhookEventTrack_webhookEventId_track_key", ["webhookEventId", "track"], true],
    ["WebhookEventTrack_status_idx", ["status"], false],
    ["WebhookEventTrack_track_status_idx", ["track", "status"], false],
    ["WebhookEventTrack_status_nextAttemptAt_idx", ["status", "nextAttemptAt"], false],
    ["WebhookEventTrack_status_nextAttemptAtUtc_idx", ["status", "nextAttemptAtUtc"], false],
  ].map(([name, columns, unique]) => ({
    name,
    columns,
    unique,
    valid: true,
    ready: true,
    predicateIsNull: true,
    noIncludeColumns: true,
    noExpressions: true,
    method: "btree",
    defaultOrdering: columns.map(() => true),
    defaultOperatorClasses: columns.map(() => true),
    columnCollationsMatch: columns.map(() => true),
  }))
  const migrationRows = WEBHOOK_CUTOVER_MIGRATION_NAMES.map((migration_name) => ({
    migration_name,
    checksum: WEBHOOK_CUTOVER_MIGRATION_CHECKSUMS[migration_name],
    finished_at: "2026-10-01T00:00:00Z",
    rolled_back_at: null,
  }))

  writeFileSync(
    dbModule,
    `import fs from "node:fs";
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8"));
const log=(value)=>fs.appendFileSync(${JSON.stringify(callsPath)},value+"\\n");
const fixtures=${JSON.stringify({ migrationRows, migratedColumns, migratedConstraints, migratedIndexes })};
const queryRawUnsafe=async(sql)=>{log("DB_RAW "+sql.slice(0,48));if(sql.includes("FROM pg_catalog.pg_roles"))return [{role_name:"worker",rolsuper:false,rolbypassrls:false}];if(sql.includes("SELECT pg_catalog.current_schema()"))return [{schema:"public"}];if(sql.includes("_prisma_migrations"))return fixtures.migrationRows;if(sql.includes("FROM pg_catalog.pg_attribute"))return fixtures.migratedColumns;if(sql.includes("FROM pg_catalog.pg_constraint"))return fixtures.migratedConstraints;if(sql.includes("FROM pg_catalog.pg_index"))return fixtures.migratedIndexes;throw new Error("Unexpected schema verification query")};
const prisma={scan:{count:async()=>state.nonterminalScans},$queryRawUnsafe:queryRawUnsafe,$queryRaw:async(strings)=>{const sql=strings.join(" ");let count;if(sql.includes("information_schema.columns"))count=state.utcColumns;else if(sql.includes('status NOT IN'))count=state.nonterminalTracks;else if(sql.includes('"nextAttemptAt" IS NOT NULL'))count=state.legacySchedule;else throw new Error("Unexpected recovery query");log("DB_QUERY "+(sql.includes("information_schema.columns")?"utc-schema":sql.includes('status NOT IN')?"track-state":"legacy-schedule"));return [{count}]},$disconnect:async()=>{}};
export { prisma };
export const getSystemPrisma=()=>prisma;`
  )
  writeFileSync(
    integrationsModule,
    `import fs from "node:fs";
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8"));
const log=(value)=>fs.appendFileSync(${JSON.stringify(callsPath)},value+"\\n");
const makeQueue=(name)=>({getJobCounts:async(...states)=>{log("QUEUE "+name+" "+states.join(","));return Object.fromEntries(states.map((value)=>[value,state.queue===name&&state.queueState===value?1:0]))},close:async()=>{}});
export const getScanQueue=()=>makeQueue("scan");
export const getWebhookTrackRetryQueue=()=>makeQueue("webhook");
export const closeRedis=async()=>{};`
  )
  writeFileSync(
    redisModule,
    `import fs from "node:fs";
const file=${JSON.stringify(redisPath)};
const log=(value)=>fs.appendFileSync(${JSON.stringify(actionLogPath)},value+"\\n");
export default class Redis { async get(key){log("GET "+key);return JSON.parse(fs.readFileSync(file,"utf8"))} async set(){log("SET");return null} async ["eval"](_script,count,key,expected){log("EVAL");const current=JSON.parse(fs.readFileSync(file,"utf8"));if(current!==expected)return 0;fs.writeFileSync(file,JSON.stringify(null));return 1} async quit(){return "OK"} }`
  )
  writeFileSync(billingModule, 'export const WEBHOOK_TRACK_CLAIM_PROTOCOL = "durable-claims/2";\n')

  executable(
    directory,
    "docker",
    `const fs=require("node:fs");const {spawnSync}=require("node:child_process");const {createHash}=require("node:crypto");const args=process.argv.slice(2);const stateFile=${JSON.stringify(statePath)};const calls=${JSON.stringify(callsPath)};fs.appendFileSync(calls,"docker "+args.join(" ")+"\\n");if(args[0]==="ps"){if(JSON.parse(fs.readFileSync(stateFile)).container)console.log("lyrashield-worker");process.exit(0)}if(args[0]==="image"&&args[1]==="inspect"){const format=args[args.indexOf("--format")+1]??"";console.log(format.includes("io.lyrashield.engine.revision")?"${"d".repeat(40)}":"${recoverySource}");process.exit(0)}if(args[0]==="inspect"){const state=JSON.parse(fs.readFileSync(stateFile));const format=args[args.indexOf("--format")+1]??"";console.log(format.includes("Health.Status")?"healthy":format.includes("Config.Image")?"${currentImage}":format.includes("State.Running")?"true":"");process.exit(0)}if(args[0]==="exec"){const printIndex=args.indexOf("printenv");if(printIndex>=0){process.stdout.write(process.env[args[printIndex+1]]??"");process.exit(0)}if(args.includes("node")){const hash=value=>createHash("sha256").update(value??"").digest("hex");console.log(JSON.stringify({databaseUrlSha256:hash(process.env.DATABASE_URL),databaseSystemUrlSha256:hash(process.env.DATABASE_SYSTEM_URL),redisUrlSha256:hash(process.env.REDIS_URL)}));process.exit(0)}process.exit(2)}if(args[0]!=="run")process.exit(2);const codeIndex=args.indexOf("-e");if(codeIndex<0)process.exit(2);let code=args[codeIndex+1];for(const [name,file] of ${JSON.stringify(
      [
        ["@lyrashield/db", dbModule],
        ["@lyrashield/integrations", integrationsModule],
        ["@lyrashield/billing", billingModule],
        ["ioredis", redisModule],
      ]
    )})code=code.replaceAll(JSON.stringify(name),JSON.stringify(file));for(const [name,file] of ${JSON.stringify(
      [
        [
          "file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs",
          pathToFileURL(path.join(root, "ops/worker/webhook-cutover-recovery.mjs")).href,
        ],
        [
          "file:///opt/lyrashield-worker-host/webhook-cutover-schema.mjs",
          pathToFileURL(path.join(root, "ops/worker/webhook-cutover-schema.mjs")).href,
        ],
      ]
    )})code=code.replaceAll(name,JSON.stringify(file).slice(1,-1));const child=spawnSync(process.execPath,["--input-type=module","-e",code,...args.slice(codeIndex+2)],{encoding:"utf8",env:process.env});process.stdout.write(child.stdout??"");process.stderr.write(child.stderr??"");process.exit(child.status??1);`
  )
  executable(
    directory,
    "systemctl",
    `const fs=require("node:fs");const args=process.argv.slice(2);const file=${JSON.stringify(statePath)};const log=${JSON.stringify(callsPath)};fs.appendFileSync(log,"systemctl "+args.join(" ")+"\\n");const unit=args.at(-1);const state=JSON.parse(fs.readFileSync(file));if(args[0]==="is-active"){const value=unit==="lyrashield-worker.service"?state.worker:unit.endsWith(".timer")?state.timer:unit==="lyrashield-worker-egress-refresh.service"?state.egress:"inactive";if(!args.includes("--quiet"))console.log(value);process.exit(value==="active"?0:3)}if(args[0]==="is-enabled"){const value=unit.endsWith(".timer")?state.timerEnabled:state.workerEnabled;console.log(value);process.exit(value==="enabled"?0:1)}if(args[0]==="disable"&&args.includes("--now")){if(unit.endsWith(".timer")){state.timer="inactive";state.timerEnabled="disabled"}else if(unit==="lyrashield-worker.service"){state.worker="inactive";state.workerEnabled="disabled"}fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}if(args[0]==="enable"&&args.includes("--now")&&unit.endsWith(".timer")){state.timer="active";state.timerEnabled="enabled";fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}if(args[0]==="stop"&&unit==="lyrashield-worker-egress-refresh.service"){state.egress="inactive";fs.writeFileSync(file,JSON.stringify(state));process.exit(0)}process.exit(0);`
  )
  executable(
    directory,
    "az",
    `const fs=require("node:fs");const {spawnSync}=require("node:child_process");const args=process.argv.slice(2);const calls=${JSON.stringify(callsPath)};const revisionsFile=${JSON.stringify(revisionsPath)};const stateFile=${JSON.stringify(statePath)};fs.appendFileSync(calls,"az "+args.join(" ")+"\\n");if(args[0]==="vm"&&args[1]==="run-command"&&args[2]==="invoke"){const remote=args[args.indexOf("--scripts")+1].replaceAll("/var/lib/lyrashield",${JSON.stringify(directory)});const state=JSON.parse(fs.readFileSync(stateFile));if(remote.includes("'recovery-hold-verify'")){state.completedVerifyCalls++;if(state.failCompletedReproof&&state.completedVerifyCalls===2)state.worker="failed";fs.writeFileSync(stateFile,JSON.stringify(state))}const result=spawnSync("bash",["-c",remote],{cwd:${JSON.stringify(root)},encoding:"utf8",env:process.env});process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");process.exit(result.status??1)}if(args[0]==="containerapp"&&args[1]==="revision"&&args[2]==="list"){const name=args[args.indexOf("--name")+1];const key=name===process.env.APP_NAME?"app":"scanner";const state=JSON.parse(fs.readFileSync(revisionsFile));const query=args[args.indexOf("--query")+1]??"";if(args.includes("--output")&&args[args.indexOf("--output")+1]==="json"){console.log(JSON.stringify(state[key].map(item=>({name:item.name,properties:{active:item.active,template:{containers:[{image:item.image}]}}}))));process.exit(0)}if(query.includes("length(@)")){console.log(state[key].filter(item=>item.active).length);process.exit(0)}if(query.includes("properties.active==")){console.log(state[key].filter(item=>item.active).map(item=>item.name).join("\\n"));process.exit(0)}console.log(state[key].map(item=>item.name).join("\\n"));process.exit(0)}if(args[0]==="containerapp"&&args[1]==="ingress"&&args[2]==="traffic"&&args[3]==="show"){const name=args[args.indexOf("--name")+1];const key=name===process.env.APP_NAME?"app":"scanner";const state=JSON.parse(fs.readFileSync(revisionsFile));state.trafficReads??={};state.trafficReads[key]=(state.trafficReads[key]??0)+1;let traffic=state.traffic?.[key]??[];if(state.trafficFailOnRead?.[key]===state.trafficReads[key])traffic=[{revisionName:"foreign-revision",weight:100}];fs.writeFileSync(revisionsFile,JSON.stringify(state));console.log(JSON.stringify(traffic));process.exit(0)}if(args[0]==="containerapp"&&args[1]==="revision"&&args[2]==="deactivate"){const name=args[args.indexOf("--name")+1];const revision=args[args.indexOf("--revision")+1];const key=name===process.env.APP_NAME?"app":"scanner";const state=JSON.parse(fs.readFileSync(revisionsFile));state[key]=state[key].map(item=>item.name===revision?{...item,active:false}:item);fs.writeFileSync(revisionsFile,JSON.stringify(state));process.exit(0)}if(args[0]==="containerapp"&&args[1]==="replica"&&args[2]==="list"){const state=JSON.parse(fs.readFileSync(revisionsFile));console.log(state.residualReplicas);process.exit(0)}process.exit(2);`
  )
  executable(
    directory,
    "curl",
    `const fs=require("node:fs");const args=process.argv.slice(2);const url=args.at(-1)??"";const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},"utf8"));fs.appendFileSync(${JSON.stringify(callsPath)},"curl "+url+"\\n");process.stdout.write(state.publicReadinessFailures.includes(url)?"503":"200");process.exit(0);`
  )
  executable(
    directory,
    "timeout",
    `const {spawnSync}=require("node:child_process");const args=process.argv.slice(2).filter(value=>!value.startsWith("--kill-after="));if(args[0]?.endsWith("s"))args.shift();const result=spawnSync(args[0],args.slice(1),{stdio:"inherit",env:process.env});process.exit(result.status??1);`
  )
  executable(directory, "sleep", `process.exit(0);`)
  executable(directory, "chown", `process.exit(0);`)
  executable(
    directory,
    "stat",
    `const args=process.argv.slice(2);if(args[0]==="-c"&&args[1]==="%u:%a"){console.log("0:600");process.exit(0)}process.exit(2);`
  )

  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    DEPLOY_SHA: recoverySource,
    RG: "lyrashield-test-rg",
    WORKER_VM_NAME: "lyrashield-test-vm",
    APP_NAME: "lyrashield-app",
    SCANNER_NAME: "lyrashield-scanner",
    GITHUB_ENV: githubEnvPath,
    LYRASHIELD_WORKER_ENV_LIB: envLibPath,
    LYRASHIELD_WORKER_RUNTIME_CONFIG: configPath,
    LYRASHIELD_WORKER_ENV_FILE: environmentPath,
    LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE: receiptPath,
    LYRASHIELD_ADMISSION_STOP_OWNER: recoveryOwner,
    LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID: recoveryRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT: "1",
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID: originalRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER: originalOwner,
    LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA: originalSource,
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID: recoveryRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT: "1",
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA: recoverySource,
    LYRASHIELD_PRODUCT_REVISION: recoverySource,
    LYRASHIELD_ENGINE_REVISION: "d".repeat(40),
    LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    WEB_IMAGE_REFERENCE: currentWebImage,
    ENGINE_REVISION: "d".repeat(40),
    APP_URL: "https://app.lyrashieldai.com",
    SCANNER_URL: "https://scanner.lyrashieldai.com",
    DATABASE_URL: databaseUrl,
    DATABASE_SYSTEM_URL: systemUrl,
    REDIS_URL: redisUrl,
  }

  function vm(phase, changes = {}) {
    const overrides = { ...changes }
    const revisedReceipt = overrides.receipt
    if (revisedReceipt)
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...revisedReceipt }), { mode: 0o600 })
    if (Object.hasOwn(overrides, "redisValue"))
      writeFileSync(redisPath, JSON.stringify(overrides.redisValue))
    if (Object.hasOwn(overrides, "receiptPresent")) {
      if (overrides.receiptPresent) {
        const next = { ...receipt, ...(overrides.receipt ?? {}) }
        writeFileSync(receiptPath, JSON.stringify(next), { mode: 0o600 })
      } else rmSync(receiptPath, { force: true })
    }
    if (Object.hasOwn(overrides, "state")) {
      const current = JSON.parse(readFileSync(statePath, "utf8"))
      writeFileSync(statePath, JSON.stringify({ ...current, ...overrides.state }))
    }
    const currentSource = overrides.currentSource ?? recoverySource
    const currentRun = overrides.currentRun ?? recoveryRunId
    const currentAttempt = overrides.currentAttempt ?? "1"
    const expectedRun = overrides.expectedRun ?? originalRunId
    const expectedSource = overrides.expectedSource ?? originalSource
    const expectedOwner = overrides.expectedOwner ?? originalOwner
    const args = [
      script,
      phase,
      currentSource,
      recoveryOwner,
      currentRun,
      "",
      currentAttempt,
      expectedRun,
      expectedSource,
      expectedOwner,
      currentRun,
      currentAttempt,
      currentSource,
    ]
    const result = spawnSync("sh", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...(overrides.env ?? {}) },
    })
    return result
  }

  function setState(changes) {
    const current = JSON.parse(readFileSync(statePath, "utf8"))
    writeFileSync(statePath, JSON.stringify({ ...current, ...changes }))
  }

  function maintenance(phase, envChanges = {}) {
    return spawnSync("bash", [maintenanceScript, phase], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...envChanges },
    })
  }

  return {
    vm,
    maintenance,
    setState,
    receiptPath,
    redisPath,
    statePath,
    revisionsPath,
    githubEnvPath,
    callsPath,
    actionLogPath,
    env,
    receipt,
  }
}

function runVerifiedCandidate(f) {
  f.setState({ worker: "active", workerEnabled: "enabled", container: true })
  const result = f.maintenance("resume-recovery")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_CUTOVER_ADMISSION_RELEASED$/m)
  return JSON.parse(readFileSync(f.receiptPath, "utf8"))
}

function completedArchive(receipt) {
  const release = receipt.recoveryReleases.at(-1)
  return {
    ...receipt,
    phase: "completed",
    recoveryCompleted: { ...release, completedAt: "2026-10-07T00:00:00.000Z" },
  }
}

function installPreparedWebRevisions(f, overrides = {}) {
  const appRevision = "lyrashield-app--prepared"
  const scannerRevision = "lyrashield-scanner--prepared"
  const image = overrides.image ?? currentWebImage
  const appImage = overrides.appImage ?? image
  const scannerImage = overrides.scannerImage ?? image
  writeFileSync(
    f.revisionsPath,
    JSON.stringify({
      app: [
        { name: appRevision, active: true, image: appImage },
        { name: "lyrashield-app--old", active: false, image: currentWebImage },
      ],
      scanner: [
        { name: scannerRevision, active: true, image: scannerImage },
        { name: "lyrashield-scanner--old", active: false, image: currentWebImage },
      ],
      residualReplicas: 0,
      traffic: {
        app: overrides.appTraffic ?? [{ revisionName: appRevision, weight: 100 }],
        scanner: overrides.scannerTraffic ?? [{ revisionName: scannerRevision, weight: 100 }],
      },
      trafficReads: {},
      trafficFailOnRead: overrides.trafficFailOnRead,
    })
  )
}

function completeRecoveryFixture(f) {
  runVerifiedCandidate(f)
  const result = f.maintenance("complete-recovery")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_COMPLETE$/m)
  const archivePath = path.join(
    path.dirname(f.receiptPath),
    `webhook-claims-cutover-completed-${originalRunId}.json`
  )
  assert.equal(existsSync(archivePath), true)
  installPreparedWebRevisions(f)
  return { archivePath, archive: readFileSync(archivePath, "utf8") }
}

test("completed recovery hold verifies and preserves the exact ready prepared writers", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  const callsBefore = readFileSync(f.callsPath, "utf8")
  const actionsBefore = readFileSync(f.actionLogPath, "utf8")
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8").slice(actionsBefore.length), /SET|EVAL/)

  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.equal(revisions.app.filter((item) => item.active).length, 1)
  assert.equal(revisions.scanner.filter((item) => item.active).length, 1)
  assert.equal(revisions.app[0].active, true)
  assert.equal(revisions.scanner[0].active, true)
  assert.deepEqual(revisions.traffic.app, [
    { revisionName: "lyrashield-app--prepared", weight: 100 },
  ])
  assert.deepEqual(revisions.traffic.scanner, [
    { revisionName: "lyrashield-scanner--prepared", weight: 100 },
  ])

  const newCalls = readFileSync(f.callsPath, "utf8").slice(callsBefore.length)
  assert.equal((newCalls.match(/recovery-hold-verify/g) ?? []).length, 2)
  assert.doesNotMatch(newCalls, /revision deactivate|systemctl disable --now|systemctl stop /)
  const dockerRuns = newCalls.split("\n").filter((line) => line.startsWith("docker run "))
  assert.ok(dockerRuns.length > 0)
  assert.ok(dockerRuns.every((line) => line.includes("--pull=never")))
  for (const endpoint of [
    "https://app.lyrashieldai.com/api/ready",
    "https://scanner.lyrashieldai.com/api/ready",
    "https://app.lyrashieldai.com/api/ready/scans",
  ])
    assert.match(newCalls, new RegExp(`curl ${endpoint.replaceAll("/", "\\/")}`))
  assert.equal(readFileSync(f.statePath, "utf8").includes('"worker":"active"'), true)
  assert.equal(readFileSync(f.statePath, "utf8").includes('"timer":"active"'), true)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("an uncompleted release with a missing stop does not qualify for completed preservation", (t) => {
  const f = fixture(t)
  runVerifiedCandidate(f)
  installPreparedWebRevisions(f)
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.deepEqual(
    revisions.app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    revisions.scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.equal(readFileSync(f.statePath, "utf8").includes('"worker":"active"'), true)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)
})

test("completed recovery hold closes writers when public readiness fails", (t) => {
  const f = fixture(t, {
    publicReadinessFailures: ["https://scanner.lyrashieldai.com/api/ready"],
  })
  const { archivePath, archive } = completeRecoveryFixture(f)
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  assert.deepEqual(
    JSON.parse(readFileSync(f.revisionsPath, "utf8")).app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    JSON.parse(readFileSync(f.revisionsPath, "utf8")).scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.equal(readFileSync(f.statePath, "utf8").includes('"worker":"active"'), true)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)
})

test("completed recovery hold closes writers when the prepared scanner image is wrong", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  installPreparedWebRevisions(f, { scannerImage: currentImage })
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.deepEqual(
    revisions.app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    revisions.scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("completed recovery hold closes writers when ingress traffic has an invalid weight", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  installPreparedWebRevisions(f, {
    appTraffic: [{ revisionName: "lyrashield-app--prepared", weight: "100.0" }],
  })
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.deepEqual(
    revisions.app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    revisions.scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("completed recovery hold closes writers when the public origin is not canonical", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  const result = f.maintenance("recovery-hold", { APP_URL: "https://unexpected.example" })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.deepEqual(
    revisions.app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    revisions.scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("completed recovery hold does not bypass proof when a final runtime recheck fails", (t) => {
  const f = fixture(t, { failCompletedReproof: true })
  const { archivePath, archive } = completeRecoveryFixture(f)
  const result = f.maintenance("recovery-hold")

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  assert.deepEqual(
    JSON.parse(readFileSync(f.revisionsPath, "utf8")).app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    JSON.parse(readFileSync(f.revisionsPath, "utf8")).scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl disable --now|systemctl stop /)
})

test("completed recovery hold closes writers when the worker digest proof is wrong", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  const result = f.maintenance("recovery-hold", {
    LYRASHIELD_WORKER_IMAGE_DIGEST: `sha256:${"9".repeat(64)}`,
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  const revisions = JSON.parse(readFileSync(f.revisionsPath, "utf8"))
  assert.deepEqual(
    revisions.app.map((item) => item.active),
    [false, false]
  )
  assert.deepEqual(
    revisions.scanner.map((item) => item.active),
    [false, false]
  )
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("completed archive rejects a foreign admission token without changing writers", (t) => {
  const f = fixture(t)
  const { archivePath, archive } = completeRecoveryFixture(f)
  writeFileSync(f.redisPath, JSON.stringify("foreign-stop-token"))
  const before = readFileSync(f.revisionsPath, "utf8")
  const actionsBefore = readFileSync(f.actionLogPath, "utf8")
  const result = f.maintenance("recovery-hold")

  assert.notEqual(result.status, 0, result.stdout)
  assert.doesNotMatch(result.stdout, /^WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED$/m)
  assert.equal(readFileSync(f.revisionsPath, "utf8"), before)
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(archivePath, "utf8"), archive)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify("foreign-stop-token"))
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /revision deactivate/)
  assert.equal(readFileSync(f.actionLogPath, "utf8"), actionsBefore)
})

test("new-run probe verifies immutable original owner and exact admission token with failed worker held", (t) => {
  const f = fixture(t)
  const before = readFileSync(f.receiptPath, "utf8")
  const result = f.vm("recovery-probe-new-run")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^WEBHOOK_NEW_RUN_RECOVERY_VERIFIED$/m)
  assert.match(result.stdout, new RegExp(`^WEBHOOK_RECOVERY_OWNER=${originalOwner}$`, "m"))
  assert.match(result.stdout, new RegExp(`^WEBHOOK_RECOVERY_OWNER_RUN_ID=${originalRunId}$`, "m"))
  assert.match(
    result.stdout,
    new RegExp(`^WEBHOOK_RECOVERY_OWNER_SOURCE_SHA=${originalSource}$`, "m")
  )
  assert.equal(readFileSync(f.receiptPath, "utf8"), before)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
  const calls = readFileSync(f.callsPath, "utf8")
  for (const queue of ["scan", "webhook"])
    assert.match(
      calls,
      new RegExp(`QUEUE ${queue} wait,active,delayed,prioritized,paused,waiting-children`)
    )
  assert.match(calls, /DB_QUERY track-state/)
  assert.match(calls, /DB_QUERY utc-schema/)
})

for (const [label, changes] of [
  ["wrong original run", { expectedRun: "37516632067" }],
  ["wrong original source", { expectedSource: "f".repeat(40) }],
  ["wrong original owner", { expectedOwner: `${originalRunId}:2` }],
  ["malformed recovery source", { currentSource: "not-a-commit" }],
  ["same run as original", { currentRun: originalRunId }],
  ["missing original run", { expectedRun: "" }],
  ["missing original source", { expectedSource: "" }],
  ["missing original owner", { expectedOwner: "" }],
]) {
  test(`new-run probe rejects ${label} without changing the held stop`, (t) => {
    const f = fixture(t)
    const result = f.vm("recovery-probe-new-run", changes)
    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
    assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
  })
}

for (const [label, changes] of [
  ["foreign token", { redisValue: "foreign-stop-token" }],
  ["missing token", { redisValue: null }],
  ["tampered receipt owner", { receipt: { owner: `${originalRunId}:2` } }],
  ["tampered receipt source", { receipt: { productRevision: "f".repeat(40) } }],
  ["malformed original attempt history", { receipt: { attempts: [1, 1], lastAttempt: 2 } }],
  ["completed receipt", { receipt: { phase: "completed" } }],
  ["tampered database identity", { receipt: { databaseUrlSha256: "0".repeat(64) } }],
]) {
  test(`new-run probe rejects ${label} and never claims or deletes Redis stop`, (t) => {
    const f = fixture(t)
    const result = f.vm("recovery-probe-new-run", changes)
    assert.notEqual(result.status, 0, result.stdout)
    assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
  })
}

test("absent receipt is reported only when the admission stop is absent", (t) => {
  const f = fixture(t, { receiptPresent: false, redisValue: null })
  const result = f.vm("recovery-probe-new-run")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_RECEIPT_ABSENT$/m)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
})

test("missing receipt with a foreign admission stop fails closed", (t) => {
  const f = fixture(t, { receiptPresent: false, redisValue: "foreign-stop-token" })
  const result = f.vm("recovery-probe-new-run")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify("foreign-stop-token"))
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
})

test("worker readback rejects a recovery source or digest that differs from the recorded candidate", () => {
  const candidate = {
    recoveryRunId,
    recoveryAttempt: 1,
    sourceRevision: recoverySource,
    engineRevision: "e".repeat(40),
    workerImage: currentImage,
    protocol: "durable-claims/2",
  }
  const receipt = { ...heldReceipt(), recoveryCandidates: [candidate] }
  const identity = {
    receipt,
    workerImage: candidate.workerImage,
    productRevision: candidate.sourceRevision,
    engineRevision: candidate.engineRevision,
    workerDigest: `sha256:${"c".repeat(64)}`,
    protocol: candidate.protocol,
    environment: {
      DATABASE_URL: databaseUrl,
      DATABASE_SYSTEM_URL: systemUrl,
      REDIS_URL: redisUrl,
    },
  }
  assert.equal(assertWebhookCutoverWorkerIdentity(identity), true)
  assert.throws(
    () => assertWebhookCutoverWorkerIdentity({ ...identity, productRevision: originalSource }),
    /recorded recovery candidate/
  )
  assert.throws(
    () =>
      assertWebhookCutoverWorkerIdentity({ ...identity, workerDigest: `sha256:${"f".repeat(64)}` }),
    /digest or protocol/
  )
})

test("held recovery skips migration execution and keeps promotion failure forward-only", () => {
  const runtime = readFileSync(".github/workflows/deploy-azure-runtime.yml", "utf8")
  const migrationStart = runtime.indexOf("- name: Run database migrations")
  assert.ok(migrationStart >= 0)
  const migrationEnd = runtime.indexOf("\n      - name:", migrationStart + 1)
  const migrationStep = runtime.slice(migrationStart, migrationEnd)
  assert.match(migrationStep, /if: inputs\.held_recovery != true/)

  const promoter = readFileSync(".github/scripts/promote-worker-vm.sh", "utf8")
  const recoveryBranch = promoter.indexOf("promotion_step=recording-webhook-candidate")
  const recoverySchema = promoter.indexOf("assert_recovery_schema", recoveryBranch)
  const restart = promoter.indexOf('systemctl restart "$service"', recoverySchema)
  assert.ok(recoveryBranch >= 0 && recoverySchema > recoveryBranch && restart > recoverySchema)
  const heldFailureStart = promoter.indexOf(
    'if [ "$promotion_complete" -ne 1 ] && [ "$webhook_cutover" -eq 1 ];'
  )
  const genericRollbackStart = promoter.indexOf(
    'if [ "$promotion_complete" -ne 1 ];',
    heldFailureStart + 1
  )
  assert.ok(heldFailureStart >= 0 && genericRollbackStart > heldFailureStart)
  const heldFailure = promoter.slice(heldFailureStart, genericRollbackStart)
  assert.match(heldFailure, /webhook maintenance held, no legacy rollback/)
  assert.doesNotMatch(
    heldFailure,
    /systemctl restart|resume_admission|redis\.call\([^\n]*DEL|cp -p "\$backup"/
  )
})

test("candidate boot failure executes the real held-cutover rollback branch without releasing its token", (t) => {
  const promoter = readFileSync(".github/scripts/promote-worker-vm.sh", "utf8")
  const rollbackStart = promoter.indexOf("rollback() {")
  const trapStart = promoter.indexOf("\ntrap rollback EXIT", rollbackStart)
  assert.ok(rollbackStart >= 0 && trapStart > rollbackStart)
  const rollbackDefinition = promoter.slice(rollbackStart, trapStart).trim()
  const directory = mkdtempSync(path.join(tmpdir(), "ls-held-cutover-rollback-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callLog = path.join(directory, "calls.log")
  const receiptPath = path.join(directory, "receipt.json")
  const redisPath = path.join(directory, "redis-stop.json")
  const token = heldReceipt().admissionStopValue
  writeFileSync(callLog, "")
  writeFileSync(receiptPath, JSON.stringify(heldReceipt()))
  writeFileSync(redisPath, JSON.stringify(token))
  const shell = `
set +e
timer=lyrashield-worker-egress-refresh.timer
service=lyrashield-worker.service
webhook_cutover=1
promotion_complete=0
promotion_step=checking-restarted-worker
systemctl(){ printf 'systemctl %s\\n' "$*" >> "$PROMOTER_TEST_CALLS"; }
cleanup_host_assets(){ printf 'cleanup_host_assets\\n' >> "$PROMOTER_TEST_CALLS"; }
${rollbackDefinition}
false
rollback
`
  const result = spawnSync("bash", ["-c", shell], {
    encoding: "utf8",
    env: { ...process.env, PROMOTER_TEST_CALLS: callLog },
  })
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /checking-restarted-worker .*webhook maintenance held, no legacy rollback/
  )
  const calls = readFileSync(callLog, "utf8")
  assert.match(calls, /systemctl disable --now lyrashield-worker-egress-refresh\.timer/)
  assert.match(calls, /systemctl disable --now lyrashield-worker\.service/)
  assert.match(calls, /cleanup_host_assets/)
  assert.doesNotMatch(calls, /systemctl restart|resume_admission|redis\.call|DEL/)
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).admissionStopValue, token)
  assert.equal(JSON.parse(readFileSync(redisPath, "utf8")), token)
})

for (const queue of ["scan", "webhook"])
  for (const queueState of [
    "wait",
    "active",
    "delayed",
    "prioritized",
    "paused",
    "waiting-children",
  ])
    test(`new-run probe rejects ${queue} queue ${queueState} work without mutation`, (t) => {
      const f = fixture(t, { queue, queueState })
      const result = f.vm("recovery-probe-new-run")
      assert.notEqual(result.status, 0, result.stdout)
      assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
      assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
    })

test("maintenance wrapper holds old writers, releases only the verified stop, and archives completion", (t) => {
  const f = fixture(t)
  const immutable = JSON.parse(readFileSync(f.receiptPath, "utf8"))
  const hold = f.maintenance("recovery-hold")
  assert.equal(hold.status, 0, `${hold.stdout}\n${hold.stderr}`)
  assert.match(hold.stdout, /^WEBHOOK_RECOVERY_HOLD_COMPLETE$/m)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(immutable.admissionStopValue))
  assert.deepEqual(JSON.parse(readFileSync(f.revisionsPath, "utf8")), {
    app: [{ name: "lyrashield-app--old", active: false }],
    scanner: [{ name: "lyrashield-scanner--old", active: false }],
    residualReplicas: 0,
  })
  const heldCalls = readFileSync(f.callsPath, "utf8")
  assert.match(heldCalls, /recovery-hold-verify/)
  assert.match(heldCalls, /recovery-hold/)
  assert.match(heldCalls, /containerapp revision deactivate --name lyrashield-app/)
  assert.match(heldCalls, /containerapp revision deactivate --name lyrashield-scanner/)
  assert.equal(JSON.parse(readFileSync(f.receiptPath, "utf8")).owner, immutable.owner)

  f.setState({ worker: "active", workerEnabled: "enabled", container: true })
  const resume = f.maintenance("resume-recovery")
  assert.equal(resume.status, 0, `${resume.stdout}\n${resume.stderr}`)
  assert.match(resume.stdout, /^WEBHOOK_CUTOVER_ADMISSION_RELEASED$/m)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  const released = JSON.parse(readFileSync(f.receiptPath, "utf8"))
  for (const field of [
    "owner",
    "runId",
    "productRevision",
    "admissionStopValue",
    "attempts",
    "lastAttempt",
    "databaseUrlSha256",
    "databaseSystemUrlSha256",
    "redisUrlSha256",
  ])
    assert.deepEqual(released[field], immutable[field], `resume changed original ${field}`)
  assert.deepEqual(released.recoveryReleases.at(-1), {
    ...released.recoveryReleases.at(-1),
    runId: recoveryRunId,
    attempt: 1,
    sourceRevision: recoverySource,
    engineRevision: "d".repeat(40),
    workerImage: currentImage,
    protocol: "durable-claims/2",
    status: "released",
  })
  assert.match(readFileSync(f.actionLogPath, "utf8"), /EVAL/)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)

  const complete = f.maintenance("complete-recovery")
  assert.equal(complete.status, 0, `${complete.stdout}\n${complete.stderr}`)
  assert.match(complete.stdout, /^WEBHOOK_RECOVERY_COMPLETE$/m)
  const completedPath = path.join(
    path.dirname(f.receiptPath),
    `webhook-claims-cutover-completed-${originalRunId}.json`
  )
  const archived = JSON.parse(readFileSync(completedPath, "utf8"))
  assert.equal(archived.phase, "completed")
  assert.equal(archived.owner, immutable.owner)
  assert.equal(archived.productRevision, immutable.productRevision)
  assert.deepEqual(archived.attempts, immutable.attempts)
  assert.equal(archived.recoveryCompleted.runId, recoveryRunId)
  assert.equal(archived.recoveryCompleted.status, "released")
  assert.ok(archived.recoveryCompleted.completedAt)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.equal(existsSync(f.receiptPath), false)
})

test("maintenance hold refuses a foreign stop before deactivating writers", (t) => {
  const f = fixture(t, { redisValue: "foreign-stop-token" })
  const before = readFileSync(f.revisionsPath, "utf8")
  const result = f.maintenance("recovery-hold")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify("foreign-stop-token"))
  assert.equal(readFileSync(f.revisionsPath, "utf8"), before)
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /revision deactivate/)
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl disable --now/)
})

test("maintenance hold stops before worker shutdown when writer replicas fail to drain", (t) => {
  const f = fixture(t, {
    residualReplicas: 1,
    workerState: "active",
    workerEnabled: "enabled",
    containerPresent: true,
  })
  const beforeReceipt = readFileSync(f.receiptPath, "utf8")
  const result = f.maintenance("recovery-hold")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
  assert.equal(readFileSync(f.receiptPath, "utf8"), beforeReceipt)
  const calls = readFileSync(f.callsPath, "utf8")
  assert.match(calls, /revision deactivate/)
  assert.doesNotMatch(calls, /systemctl disable --now/)
  assert.match(readFileSync(f.statePath, "utf8"), /"worker":"active"/)
})

for (const [label, changes] of [
  ["wrong original owner", { LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER: `${originalRunId}:2` }],
  ["wrong recovery source", { LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA: "f".repeat(40) }],
  ["wrong recovery run", { LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID: originalRunId }],
])
  test(`maintenance hold rejects ${label} before cloud mutation`, (t) => {
    const f = fixture(t)
    const before = readFileSync(f.revisionsPath, "utf8")
    const result = f.maintenance("recovery-hold", changes)
    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(f.revisionsPath, "utf8"), before)
    assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /revision deactivate/)
    assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
  })

test("maintenance release rejects a foreign admission value without deleting it", (t) => {
  const f = fixture(t, {
    redisValue: "foreign-stop-token",
    workerState: "active",
    workerEnabled: "enabled",
    containerPresent: true,
  })
  const before = readFileSync(f.receiptPath, "utf8")
  const result = f.maintenance("resume-recovery")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify("foreign-stop-token"))
  assert.equal(readFileSync(f.receiptPath, "utf8"), before)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /EVAL|SET/)
})

test("maintenance release leaves the exact token held when candidate boot is unhealthy", (t) => {
  const f = fixture(t)
  const before = readFileSync(f.receiptPath, "utf8")
  const result = f.maintenance("resume-recovery")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
  assert.equal(readFileSync(f.receiptPath, "utf8"), before)
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl enable --now/)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /EVAL|SET/)
})

test("maintenance release reconciles a lost delete acknowledgement from release intent plus absent stop", (t) => {
  const f = fixture(t)
  const before = JSON.parse(readFileSync(f.receiptPath, "utf8"))
  const candidate = before.recoveryCandidates.at(-1)
  const releaseIntent = {
    runId: recoveryRunId,
    attempt: 1,
    sourceRevision: recoverySource,
    engineRevision: candidate.engineRevision,
    workerImage: candidate.workerImage,
    protocol: "durable-claims/2",
    status: "release-intent",
    startedAt: "2026-10-07T00:00:00.000Z",
  }
  writeFileSync(f.receiptPath, JSON.stringify({ ...before, recoveryReleases: [releaseIntent] }), {
    mode: 0o600,
  })
  writeFileSync(f.redisPath, "null")
  f.setState({
    worker: "active",
    workerEnabled: "enabled",
    timer: "active",
    timerEnabled: "enabled",
    container: true,
    nonterminalScans: 1,
    nonterminalTracks: 1,
    legacySchedule: 1,
    queue: "scan",
    queueState: "active",
  })

  const result = f.maintenance("resume-recovery")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_CUTOVER_ADMISSION_RELEASED$/m)
  const reconciled = JSON.parse(readFileSync(f.receiptPath, "utf8"))
  assert.equal(reconciled.recoveryReleases.at(-1).status, "released")
  for (const field of [
    "owner",
    "runId",
    "productRevision",
    "admissionStopValue",
    "attempts",
    "lastAttempt",
  ])
    assert.deepEqual(reconciled[field], before[field])
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)
})

for (const [label, state] of [
  ["active queue work", { queue: "scan", queueState: "active" }],
  ["nonterminal scans", { nonterminalScans: 1 }],
  ["nonterminal webhook tracks", { nonterminalTracks: 1 }],
  ["legacy scheduled tracks", { legacySchedule: 1 }],
])
  test(`maintenance release keeps the admission stop held when ${label} remain`, (t) => {
    const f = fixture(t)
    f.setState({ worker: "active", workerEnabled: "enabled", container: true, ...state })
    const before = readFileSync(f.receiptPath, "utf8")
    const result = f.maintenance("resume-recovery")
    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
    assert.equal(readFileSync(f.receiptPath, "utf8"), before)
    assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /EVAL|SET/)
    assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl enable --now/)
  })

for (const [label, changes] of [
  ["worker digest", { workerImage: `${currentImage.slice(0, -64)}${"e".repeat(64)}` }],
  ["claim protocol", { protocol: "legacy-claims/1" }],
])
  test(`maintenance release rejects a recorded candidate with a changed ${label}`, (t) => {
    const f = fixture(t)
    const before = JSON.parse(readFileSync(f.receiptPath, "utf8"))
    const recoveryCandidates = before.recoveryCandidates.map((candidate, index) =>
      index === before.recoveryCandidates.length - 1 ? { ...candidate, ...changes } : candidate
    )
    const tampered = { ...before, recoveryCandidates }
    writeFileSync(f.receiptPath, JSON.stringify(tampered), { mode: 0o600 })
    f.setState({ worker: "active", workerEnabled: "enabled", container: true })
    const result = f.maintenance("resume-recovery")
    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(before.admissionStopValue))
    assert.equal(readFileSync(f.receiptPath, "utf8"), JSON.stringify(tampered))
    assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /EVAL|SET/)
    assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl enable --now/)
  })

test("post-release recovery hold does not stop the healthy candidate or create an admission stop", (t) => {
  const f = fixture(t)
  runVerifiedCandidate(f)
  const callsBefore = readFileSync(f.callsPath, "utf8")
  const result = f.maintenance("recovery-hold")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP$/m)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  const state = JSON.parse(readFileSync(f.statePath, "utf8"))
  assert.equal(state.worker, "active")
  assert.equal(state.workerEnabled, "enabled")
  assert.equal(state.timer, "active")
  assert.equal(state.timerEnabled, "enabled")
  const newCalls = readFileSync(f.callsPath, "utf8").slice(callsBefore.length)
  assert.doesNotMatch(newCalls, /systemctl disable --now|systemctl stop lyrashield-worker/)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)
})

test("completion retry reconciles matching active receipt and completed archive", (t) => {
  const f = fixture(t)
  const released = runVerifiedCandidate(f)
  const archivePath = path.join(
    path.dirname(f.receiptPath),
    `webhook-claims-cutover-completed-${originalRunId}.json`
  )
  const archive = completedArchive(released)
  writeFileSync(archivePath, JSON.stringify(archive), { mode: 0o600 })
  const result = f.maintenance("complete-recovery")
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^WEBHOOK_RECOVERY_COMPLETE$/m)
  assert.equal(existsSync(f.receiptPath), false)
  assert.deepEqual(JSON.parse(readFileSync(archivePath, "utf8")), archive)
})

test("completion archive-only retry is idempotent", (t) => {
  const f = fixture(t)
  runVerifiedCandidate(f)
  const first = f.maintenance("complete-recovery")
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
  const archivePath = path.join(
    path.dirname(f.receiptPath),
    `webhook-claims-cutover-completed-${originalRunId}.json`
  )
  const before = readFileSync(archivePath, "utf8")
  const retry = f.maintenance("complete-recovery")
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`)
  assert.match(retry.stdout, /^WEBHOOK_RECOVERY_COMPLETE$/m)
  assert.equal(readFileSync(archivePath, "utf8"), before)
  assert.equal(existsSync(f.receiptPath), false)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("completion refuses a mismatched archive without deleting the active release receipt", (t) => {
  const f = fixture(t)
  const released = runVerifiedCandidate(f)
  const archivePath = path.join(
    path.dirname(f.receiptPath),
    `webhook-claims-cutover-completed-${originalRunId}.json`
  )
  const wrongArchive = { ...completedArchive(released), owner: `${originalRunId}:2` }
  writeFileSync(archivePath, JSON.stringify(wrongArchive), { mode: 0o600 })
  const beforeActive = readFileSync(f.receiptPath, "utf8")
  const result = f.maintenance("complete-recovery")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.receiptPath, "utf8"), beforeActive)
  assert.deepEqual(JSON.parse(readFileSync(archivePath, "utf8")), wrongArchive)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
})

test("maintenance completion failure retains the active receipt and does not revive legacy worker", (t) => {
  const f = fixture(t)
  const held = f.maintenance("recovery-hold")
  assert.equal(held.status, 0, `${held.stdout}\n${held.stderr}`)
  f.setState({ worker: "active", workerEnabled: "enabled", container: true })
  const released = f.maintenance("resume-recovery")
  assert.equal(released.status, 0, `${released.stdout}\n${released.stderr}`)
  f.setState({ worker: "failed" })
  const before = readFileSync(f.receiptPath, "utf8")
  const result = f.maintenance("complete-recovery")
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(readFileSync(f.receiptPath, "utf8"), before)
  assert.equal(readFileSync(f.redisPath, "utf8"), "null")
  assert.doesNotMatch(readFileSync(f.callsPath, "utf8"), /systemctl restart/)
  assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET/)
  assert.ok(!readFileSync(f.receiptPath, "utf8").includes('"phase":"completed"'))
})

for (const [label, changes] of [
  ["nonterminal scans", { nonterminalScans: 1 }],
  ["nonterminal webhook tracks", { nonterminalTracks: 1 }],
  ["legacy scheduled tracks", { utcColumns: 0, legacySchedule: 1 }],
  ["partial UTC schema", { utcColumns: 1 }],
  ["active worker", { worker: "active" }],
  ["enabled worker", { workerEnabled: "enabled" }],
  ["active timer", { timer: "active" }],
  ["worker container still present", { container: true }],
]) {
  test(`new-run probe rejects ${label} and preserves original stop`, (t) => {
    const f = fixture(t)
    const result = f.vm("recovery-probe-new-run", {
      state: changes,
    })
    assert.notEqual(result.status, 0, result.stdout)
    assert.equal(readFileSync(f.redisPath, "utf8"), JSON.stringify(f.receipt.admissionStopValue))
    assert.doesNotMatch(readFileSync(f.actionLogPath, "utf8"), /SET|EVAL/)
  })
}
