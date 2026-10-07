import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const root = process.cwd()
const entry = path.join(root, ".github/scripts/finalize-held-webhook-recovery.mjs")
const originalRunId = "37516632066"
const originalSource = "af2b7a5acf34cf23a6577181de92e8d010f0beb2"
const recoveryRunId = "37520000000"
const recoveryAttempt = "2"
const recoverySource = "b".repeat(40)
const finalizerRunId = "37530000000"
const finalizerSource = "e".repeat(40)
const engineRevision = "d".repeat(40)
const workerImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"c".repeat(64)}`
const webImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"f".repeat(64)}`
const otherWebImage = `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"9".repeat(64)}`
const appName = "lyrashield-app"
const scannerName = "lyrashield-scanner"
const appCandidate = "lyrashield-app--prepared"
const scannerCandidate = "lyrashield-scanner--prepared"

function executable(directory, name, source) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`)
  chmodSync(file, 0o755)
  return file
}

function revision(name, image, active = false) {
  return { name, properties: { active, template: { containers: [{ image }] } } }
}

function initialState(options = {}) {
  const app = [
    revision("lyrashield-app--legacy", otherWebImage, options.foreignActive === "app"),
    revision(appCandidate, webImage, options.appActive ?? false),
  ]
  const scanner = [
    revision("lyrashield-scanner--legacy", otherWebImage, options.foreignActive === "scanner"),
    revision(scannerCandidate, webImage, options.scannerActive ?? false),
  ]
  if (options.ambiguous === "app")
    app.push(revision("lyrashield-app--prepared-duplicate", webImage))
  if (options.ambiguous === "scanner")
    scanner.push(revision("lyrashield-scanner--prepared-duplicate", webImage))
  return {
    apps: { [appName]: app, [scannerName]: scanner },
    traffic: { [appName]: [], [scannerName]: [] },
    replicaCounts: options.replicaCounts ?? {},
    completed: options.completed ?? false,
    ackLostRemaining: options.ackLostRemaining ?? 0,
    mutationTimeoutRemaining: options.mutationTimeoutRemaining ?? 0,
    residualOnCompensation: options.residualOnCompensation ?? false,
    probeCount: 0,
    probeUnavailableAt: options.probeUnavailableAt ?? 0,
    vmPhases: [],
  }
}

function makeFixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-finalizer-cli-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, "azure-state.json")
  const callLog = path.join(directory, "calls.jsonl")
  const fetchLog = path.join(directory, "fetches.txt")
  const preload = path.join(directory, "fetch-preload.cjs")
  writeFileSync(statePath, JSON.stringify(initialState(options)))
  writeFileSync(callLog, "")
  writeFileSync(fetchLog, "")
  writeFileSync(
    preload,
    `
const fs=require("node:fs");
const append=${JSON.stringify(fetchLog)};
const nativeTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,_delay,...args)=>nativeTimeout(callback,0,...args);
globalThis.fetch=async(url)=>{
 fs.appendFileSync(append,String(url)+"\\n");
 return {status:process.env.LYRA_TEST_SMOKE_FAIL==="1"?503:200,body:{cancel:async()=>{}}};
};
`
  )

  executable(
    directory,
    "git",
    `
const fs=require("node:fs");const args=process.argv.slice(2);
if(args.join(" ")==="rev-parse HEAD"){process.stdout.write(process.env.LYRA_TEST_OPERATIONS_SHA+"\\n");process.exit(0)}
process.exit(2);
`
  )
  executable(
    directory,
    "gh",
    `
const fs=require("node:fs");const args=process.argv.slice(2);const log=process.env.LYRA_TEST_CALL_LOG;
fs.appendFileSync(log,JSON.stringify(["gh",...args])+"\\n");
if(args[0]!=="api")process.exit(2);
const resource=args[1]||"";const op=process.env.LYRA_TEST_OPERATIONS_SHA;
const original={id:Number(${JSON.stringify(originalRunId)}),run_attempt:1,head_sha:${JSON.stringify(originalSource)},head_branch:"main",path:".github/workflows/release-production.yml",event:"push",status:"completed",conclusion:"failure"};
const recovery={id:Number(${JSON.stringify(recoveryRunId)}),run_attempt:Number(${JSON.stringify(recoveryAttempt)}),head_sha:${JSON.stringify(recoverySource)},head_branch:"main",path:".github/workflows/recover-held-webhook-cutover.yml",event:"workflow_dispatch",status:"completed",conclusion:"failure"};
const finalizer={id:Number(process.env.GITHUB_RUN_ID),run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),head_sha:op,head_branch:"main",path:".github/workflows/finalize-held-webhook-recovery.yml",event:"workflow_dispatch",status:process.env.LYRA_TEST_FINALIZER_STATUS||"in_progress",conclusion:process.env.LYRA_TEST_FINALIZER_CONCLUSION||null};
const priorFinalizer={id:Number(${JSON.stringify(finalizerRunId)}),run_attempt:1,head_sha:${JSON.stringify(finalizerSource)},head_branch:"main",path:".github/workflows/finalize-held-webhook-recovery.yml",event:"workflow_dispatch",status:"completed",conclusion:"failure"};
if(resource.endsWith("/git/ref/heads/main")){console.log(JSON.stringify({object:{sha:process.env.LYRA_TEST_MAIN_SHA||op}}));process.exit(0)}
if(resource.includes("/actions/runs/${originalRunId}/attempts/1")){console.log(JSON.stringify(original));process.exit(0)}
if(resource.includes("/actions/runs/${recoveryRunId}/attempts/2")){console.log(JSON.stringify(recovery));process.exit(0)}
if(resource.includes("/actions/runs/${finalizerRunId}/attempts/1")){console.log(JSON.stringify(process.env.GITHUB_RUN_ATTEMPT==="1"?finalizer:priorFinalizer));process.exit(0)}
if(resource.includes("/actions/runs/"+process.env.GITHUB_RUN_ID+"/attempts/"+process.env.GITHUB_RUN_ATTEMPT)){console.log(JSON.stringify(finalizer));process.exit(0)}
if(resource.endsWith("/actions/runs/"+process.env.GITHUB_RUN_ID)){console.log(JSON.stringify(finalizer));process.exit(0)}
process.exit(3);
`
  )
  executable(
    directory,
    "az",
    `
const fs=require("node:fs");const args=process.argv.slice(2);const log=process.env.LYRA_TEST_CALL_LOG;const statePath=process.env.LYRA_TEST_STATE;
const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const record=()=>fs.appendFileSync(log,JSON.stringify(["az",...args])+"\\n");record();
const value=(flag)=>{const at=args.indexOf(flag);return at<0?"":args[at+1]};
const appKey=name=>name===process.env.APP_NAME?process.env.APP_NAME:name===process.env.SCANNER_NAME?process.env.SCANNER_NAME:"";
if(args[0]==="vm"&&args[1]==="run-command"&&args[2]==="invoke"){
 const payload=value("--scripts")||"";
 if(payload.includes("'complete-postrelease'")){
  state.vmPhases.push("complete-postrelease");
  state.completed=true;save();
  if(state.ackLostRemaining>0){state.ackLostRemaining--;save();process.exit(124)}
  console.log(JSON.stringify({value:[{message:"WEBHOOK_RECOVERY_COMPLETE\\nWEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE"}]}));process.exit(0)
 }
 state.vmPhases.push("postrelease-probe");state.probeCount++;save();
 if(state.probeUnavailableAt===state.probeCount)process.exit(1)
 const audit=state.completed?[
  "WEBHOOK_POST_RELEASE_AUDIT_STATE=present",
  "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_RUN_ID=${finalizerRunId}",
  "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_ATTEMPT=1",
  "WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_SOURCE_SHA=${finalizerSource}",
 ]:["WEBHOOK_POST_RELEASE_AUDIT_STATE=absent"];
 const message=[
  "WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED",
  "WEBHOOK_POST_RELEASE_ORIGINAL_OWNER=${originalRunId}:1",
  "WEBHOOK_POST_RELEASE_RECOVERY_RUN_ID=${recoveryRunId}",
  "WEBHOOK_POST_RELEASE_RECOVERY_ATTEMPT=${recoveryAttempt}",
  "WEBHOOK_POST_RELEASE_RECOVERY_SOURCE_SHA=${recoverySource}",
  "WEBHOOK_POST_RELEASE_FINALIZER_RUN_ID=${finalizerRunId}",
  "WEBHOOK_POST_RELEASE_FINALIZER_ATTEMPT=1",
  "WEBHOOK_POST_RELEASE_FINALIZER_SOURCE_SHA=${finalizerSource}",
  "WEBHOOK_POST_RELEASE_WORKER_IMAGE=${workerImage}",
  "WEBHOOK_POST_RELEASE_WEB_IMAGE=${webImage}",
  "WEBHOOK_POST_RELEASE_ENGINE_REVISION=${engineRevision}",
  "WEBHOOK_POST_RELEASE_RECEIPT_STATE="+(state.completed?"completed":"released"),
  ...audit,
 ].join("\\n");
 console.log(JSON.stringify({value:[{message}]}));process.exit(0)
}
if(args[0]==="containerapp"&&args[1]==="revision"&&args[2]==="list"){
 const name=value("--name");const inventory=state.apps[name];if(!inventory)process.exit(2);console.log(JSON.stringify(inventory));process.exit(0)
}
if(args[0]==="containerapp"&&args[1]==="replica"&&args[2]==="list"){
 const name=value("--name"),revision=value("--revision");const count=state.replicaCounts[name+":"+revision]||0;
 console.log(JSON.stringify(Array.from({length:count},(_,index)=>({name:"replica-"+index}))));process.exit(0)
}
if(args[0]==="containerapp"&&args[1]==="ingress"&&args[2]==="traffic"&&args[3]==="show"){
 const name=value("--name");console.log(JSON.stringify(state.traffic[name]||[]));process.exit(0)
}
if(args[0]==="containerapp"&&args[1]==="revision"&&(args[2]==="activate"||args[2]==="deactivate")){
 const name=value("--name"),revisionName=value("--revision"),key=appKey(name);const inventory=state.apps[key];
 if(!inventory)process.exit(2);
 const item=inventory.find(entry=>entry.name===revisionName);if(!item)process.exit(2);
 if(args[2]==="deactivate"&&state.residualOnCompensation&&revisionName===${JSON.stringify(appCandidate)}){process.exit(0)}
 item.properties.active=args[2]==="activate";save();
 if(args[2]==="activate"&&${Boolean(options.interruptAfterFirstActivation)}&&revisionName===${JSON.stringify(appCandidate)}){process.kill(process.ppid,${JSON.stringify(options.interruptionSignal ?? "SIGTERM")});process.exit(143)}
 if(args[2]==="activate"&&state.mutationTimeoutRemaining>0){state.mutationTimeoutRemaining--;save();process.exit(124)}
 process.exit(0)
}
if(args[0]==="containerapp"&&args[1]==="ingress"&&args[2]==="traffic"&&args[3]==="set"){
 const name=value("--name"),key=appKey(name),weight=value("--revision-weight");const [revisionName,rawWeight]=weight.split("=");
 if(!state.apps[key]?.some(item=>item.name===revisionName))process.exit(2);
 state.traffic[key]=[{revisionName,weight:Number(rawWeight)}];save();process.exit(0)
}
process.exit(2);
`
  )

  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    NODE_OPTIONS: `--require=${preload}`,
    GITHUB_REPOSITORY: "ecryptoguru/lyrashield-ai",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: finalizerRunId,
    GITHUB_RUN_ATTEMPT: "1",
    DEPLOY_SHA: finalizerSource,
    APP_NAME: appName,
    SCANNER_NAME: scannerName,
    APP_URL: "https://app.lyrashieldai.com",
    SCANNER_URL: "https://scanner.lyrashieldai.com",
    RG: "production-rg",
    WORKER_VM_NAME: "lyrashield-worker",
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID: originalRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER: `${originalRunId}:1`,
    LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA: originalSource,
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID: recoveryRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT: recoveryAttempt,
    LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA: recoverySource,
    LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_RUN_ID: finalizerRunId,
    LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_ATTEMPT: "1",
    LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_SOURCE_SHA: finalizerSource,
    LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WORKER_IMAGE: workerImage,
    LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WEB_IMAGE: webImage,
    LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_ENGINE_REVISION: engineRevision,
    LYRA_TEST_OPERATIONS_SHA: finalizerSource,
    LYRA_TEST_STATE: statePath,
    LYRA_TEST_CALL_LOG: callLog,
    LYRA_TEST_FETCH_LOG: fetchLog,
    LYRA_TEST_SMOKE_FAIL: options.smokeFail ? "1" : "0",
  }

  function run(mode, overrides = {}) {
    return spawnSync(process.execPath, [entry, mode], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...overrides },
      timeout: 120_000,
    })
  }
  function state() {
    return JSON.parse(readFileSync(statePath, "utf8"))
  }
  function calls() {
    return readFileSync(callLog, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
  }
  function resetCalls() {
    writeFileSync(callLog, "")
    writeFileSync(fetchLog, "")
    const current = state()
    current.vmPhases = []
    writeFileSync(statePath, JSON.stringify(current))
  }
  return { run, state, calls, resetCalls, fetchLog }
}

function mutationCalls(fixture) {
  return fixture
    .calls()
    .filter(
      ([, ...args]) =>
        args[0] === "containerapp" &&
        ((args[1] === "revision" && ["activate", "deactivate"].includes(args[2])) ||
          (args[1] === "ingress" && args[2] === "traffic" && args[3] === "set"))
    )
}

function assertOnlyPreparedRevisions(fixture, active) {
  const state = fixture.state()
  for (const [name, candidate] of [
    [appName, appCandidate],
    [scannerName, scannerCandidate],
  ]) {
    const activeNames = state.apps[name]
      .filter((item) => item.properties.active)
      .map((item) => item.name)
    assert.deepEqual(activeNames, active ? [candidate] : [])
  }
}

function assertNoWorkerOrRedisOperations(fixture) {
  for (const [, ...args] of fixture.calls()) {
    assert.ok(!args.some((arg) => /(?:systemctl|docker|redis|migrate deploy)/i.test(String(arg))))
  }
}

function assertHoldOnlyTouchedSelectedRevisions(fixture, expectedDeactivations) {
  const calls = fixture.calls()
  assert.deepEqual(fixture.state().vmPhases, ["postrelease-probe"])
  assert.ok(
    !calls.some(
      ([program, ...args]) =>
        program === "az" &&
        args[0] === "containerapp" &&
        args[1] === "ingress" &&
        args[2] === "traffic" &&
        args[3] === "set"
    )
  )
  assert.deepEqual(
    mutationCalls(fixture)
      .filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .map(([, ...args]) => [args[4], args[8]])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [...expectedDeactivations].sort((a, b) => a[0].localeCompare(b[0]))
  )
  assert.equal(readFileSync(fixture.fetchLog, "utf8"), "")
  assertNoWorkerOrRedisOperations(fixture)
}

function diagnostic(fixture, result) {
  const calls = fixture.calls().map(([program, ...args]) => {
    const safeArgs = [...args]
    const scriptIndex = safeArgs.indexOf("--scripts")
    if (scriptIndex !== -1 && scriptIndex + 1 < safeArgs.length)
      safeArgs[scriptIndex + 1] = "<VM script omitted>"
    return [program, ...safeArgs]
  })
  return `${result.stdout}\n${result.stderr}\n${JSON.stringify(calls, null, 2)}`
}

test("--plan runs exact read-only proofs and performs no Azure mutations or public requests", (t) => {
  const f = makeFixture(t)
  const result = f.run("--plan")
  assert.equal(result.status, 0, diagnostic(f, result))
  assert.match(result.stdout, /plan passed; no revisions were activated/)
  assert.deepEqual(mutationCalls(f), [])
  assert.equal(readFileSync(f.fetchLog, "utf8"), "")
  assertNoWorkerOrRedisOperations(f)
})

test("--apply accepts empty Azure mutation output and resumes a partially activated exact pair", (t) => {
  const f = makeFixture(t, { appActive: true })
  const result = f.run("--apply")
  assert.equal(result.status, 0, diagnostic(f, result))
  assertOnlyPreparedRevisions(f, true)
  const mutations = mutationCalls(f)
  assert.equal(
    mutations.filter(([, ...args]) => args[1] === "revision" && args[2] === "activate").length,
    1
  )
  assert.ok(
    mutations.some(
      ([, ...args]) =>
        args[1] === "revision" && args[2] === "activate" && args.includes(scannerCandidate)
    )
  )
  assert.ok(
    !mutations.some(
      ([, ...args]) =>
        args[1] === "revision" && args[2] === "activate" && args.includes(appCandidate)
    )
  )
  assert.equal(
    mutations.filter(
      ([, ...args]) => args[1] === "ingress" && args[2] === "traffic" && args[3] === "set"
    ).length,
    2
  )
  assert.ok(!mutations.some(([, ...args]) => args[1] === "revision" && args[2] === "deactivate"))
  assert.match(readFileSync(f.fetchLog, "utf8"), /https:\/\/app\.lyrashieldai\.com\/api\/ready/)
  assert.match(readFileSync(f.fetchLog, "utf8"), /https:\/\/scanner\.lyrashieldai\.com\/api\/ready/)
  assert.match(
    readFileSync(f.fetchLog, "utf8"),
    /https:\/\/app\.lyrashieldai\.com\/api\/ready\/scans/
  )
  assertNoWorkerOrRedisOperations(f)
})

test("--apply tolerates both exact prepared revisions already active without reactivation", (t) => {
  const f = makeFixture(t, { appActive: true, scannerActive: true })
  const result = f.run("--apply")
  assert.equal(result.status, 0, diagnostic(f, result))
  assertOnlyPreparedRevisions(f, true)
  const mutations = mutationCalls(f)
  assert.equal(
    mutations.filter(([, ...args]) => args[1] === "revision" && args[2] === "activate").length,
    0
  )
  assertNoWorkerOrRedisOperations(f)
})

test("--plan rejects foreign active writers, duplicate candidates, and residual legacy replicas before mutation", (t) => {
  for (const options of [
    { foreignActive: "app" },
    { ambiguous: "scanner" },
    { replicaCounts: { [`${appName}:lyrashield-app--legacy`]: 1 } },
  ]) {
    const f = makeFixture(t, options)
    const result = f.run("--plan")
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(f.calls().some(([program, ...args]) => program === "gh" && args[0] === "api"))
    assert.ok(
      f
        .calls()
        .some(
          ([program, ...args]) => program === "az" && args[0] === "vm" && args[1] === "run-command"
        )
    )
    assert.ok(
      f
        .calls()
        .some(
          ([program, ...args]) =>
            program === "az" && args[0] === "containerapp" && args[1] === "revision"
        )
    )
    assert.deepEqual(mutationCalls(f), [])
    assert.equal(readFileSync(f.fetchLog, "utf8"), "")
    assertNoWorkerOrRedisOperations(f)
  }
})

test("public readiness failure compensates only the chosen revisions and confirms both inactive", (t) => {
  const f = makeFixture(t, { smokeFail: true })
  const result = f.run("--apply")
  assert.notEqual(result.status, 0)
  assertOnlyPreparedRevisions(f, false)
  const mutations = mutationCalls(f)
  assert.deepEqual(
    mutations
      .filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .map(([, ...args]) => [args[4], args[8]])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      [appName, appCandidate],
      [scannerName, scannerCandidate],
    ].sort((a, b) => a[0].localeCompare(b[0]))
  )
  assert.ok(
    mutations
      .filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .every(([, ...args]) => args.includes(appCandidate) || args.includes(scannerCandidate))
  )
  assert.equal(f.state().completed, false)
  assert.ok(readFileSync(f.fetchLog, "utf8").length > 0)
  assertNoWorkerOrRedisOperations(f)
})

test("ambiguous Azure mutation timeout compensates the selected pair without retrying activation", (t) => {
  const f = makeFixture(t, { mutationTimeoutRemaining: 1 })
  const result = f.run("--apply")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /timed out with an ambiguous remote outcome/)
  assertOnlyPreparedRevisions(f, false)
  const mutations = mutationCalls(f)
  assert.equal(
    mutations.filter(([, ...args]) => args[1] === "revision" && args[2] === "activate").length,
    1
  )
  assert.equal(
    mutations.filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate").length,
    1
  )
  assert.deepEqual(
    mutations
      .filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .map(([, ...args]) => [args[4], args[8]]),
    [[appName, appCandidate]]
  )
  assert.equal(f.state().completed, false)
  assertNoWorkerOrRedisOperations(f)
})

test("lost archive acknowledgement keeps active writers, workflow hold preserves completion, and rerun archives idempotently", (t) => {
  const f = makeFixture(t, { ackLostRemaining: 1, probeUnavailableAt: 3 })
  const first = f.run("--apply")
  assert.notEqual(first.status, 0)
  assert.match(first.stderr, /state could not be proved; no writer closure was attempted/)
  assertOnlyPreparedRevisions(f, true)
  assert.equal(
    f.state().completed,
    true,
    "VM completion persisted before the Azure acknowledgement was lost"
  )
  assert.equal(
    mutationCalls(f).filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .length,
    0
  )

  f.resetCalls()
  const held = f.run("--hold", {
    LYRA_TEST_FINALIZER_STATUS: "completed",
    LYRA_TEST_FINALIZER_CONCLUSION: "failure",
    LYRA_TEST_MAIN_SHA: "8".repeat(40),
  })
  assert.equal(held.status, 0, diagnostic(f, held))
  assert.match(held.stdout, /already complete; no writer closure was performed/)
  assertOnlyPreparedRevisions(f, true)
  assertHoldOnlyTouchedSelectedRevisions(f, [])

  f.resetCalls()
  const retry = f.run("--apply")
  assert.equal(retry.status, 0, diagnostic(f, retry))
  assertOnlyPreparedRevisions(f, true)
  assert.equal(f.state().completed, true)
  assert.equal(
    f.calls().filter(([, ...args]) => args[0] === "vm" && args[1] === "run-command").length,
    4
  )
  assert.equal(
    mutationCalls(f).filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .length,
    0
  )
  assertNoWorkerOrRedisOperations(f)
})

test("--hold fails closed without deactivation when the receipt probe is unavailable", (t) => {
  const f = makeFixture(t, {
    appActive: true,
    scannerActive: true,
    probeUnavailableAt: 1,
  })
  const result = f.run("--hold", {
    LYRA_TEST_FINALIZER_STATUS: "completed",
    LYRA_TEST_FINALIZER_CONCLUSION: "cancelled",
    LYRA_TEST_MAIN_SHA: "8".repeat(40),
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /state could not be proved; no writer closure was attempted/)
  assertOnlyPreparedRevisions(f, true)
  assert.deepEqual(mutationCalls(f), [])
  assertHoldOnlyTouchedSelectedRevisions(f, [])
})

test("a previously completed receipt with failed new readiness preserves active writers but reports failure", (t) => {
  const f = makeFixture(t, {
    completed: true,
    appActive: true,
    scannerActive: true,
    smokeFail: true,
  })
  const result = f.run("--apply")
  assert.notEqual(result.status, 0)
  assertOnlyPreparedRevisions(f, true)
  assert.equal(f.state().completed, true)
  assert.equal(
    mutationCalls(f).filter(([, ...args]) => args[1] === "revision" && args[2] === "deactivate")
      .length,
    0
  )
  assertNoWorkerOrRedisOperations(f)
})

test("--hold closes only active prepared revisions after failure or cancellation despite main advancing", (t) => {
  for (const conclusion of ["failure", "cancelled"]) {
    const f = makeFixture(t, { appActive: true, scannerActive: true })
    const result = f.run("--hold", {
      LYRA_TEST_FINALIZER_STATUS: "completed",
      LYRA_TEST_FINALIZER_CONCLUSION: conclusion,
      LYRA_TEST_MAIN_SHA: "8".repeat(40),
    })
    assert.equal(result.status, 0, diagnostic(f, result))
    assertOnlyPreparedRevisions(f, false)
    assertHoldOnlyTouchedSelectedRevisions(f, [
      [appName, appCandidate],
      [scannerName, scannerCandidate],
    ])
    assert.ok(
      !f.calls().some(([, ...args]) => args[0] === "api" && args[1]?.endsWith("git/ref/heads/main"))
    )
  }
})

test("--hold resumes closure after an uncatchable cancellation interrupted the first activation", (t) => {
  const f = makeFixture(t, {
    interruptAfterFirstActivation: true,
    interruptionSignal: "SIGKILL",
  })
  const interrupted = f.run("--apply")
  assert.equal(interrupted.signal, "SIGKILL")
  assert.deepEqual(
    f
      .state()
      .apps[appName].filter((item) => item.properties.active)
      .map((item) => item.name),
    [appCandidate]
  )
  assert.deepEqual(
    f
      .state()
      .apps[scannerName].filter((item) => item.properties.active)
      .map((item) => item.name),
    []
  )

  f.resetCalls()
  const held = f.run("--hold", {
    LYRA_TEST_FINALIZER_STATUS: "completed",
    LYRA_TEST_FINALIZER_CONCLUSION: "cancelled",
    LYRA_TEST_MAIN_SHA: "8".repeat(40),
  })
  assert.equal(held.status, 0, diagnostic(f, held))
  assertOnlyPreparedRevisions(f, false)
  assertHoldOnlyTouchedSelectedRevisions(f, [[appName, appCandidate]])
})

test("--hold fails closed for ambiguous or foreign active revisions", (t) => {
  const ambiguous = makeFixture(t, { ambiguous: "app", appActive: true })
  const ambiguousResult = ambiguous.run("--hold", {
    LYRA_TEST_FINALIZER_STATUS: "completed",
    LYRA_TEST_FINALIZER_CONCLUSION: "failure",
    LYRA_TEST_MAIN_SHA: "8".repeat(40),
  })
  assert.notEqual(ambiguousResult.status, 0)
  assert.deepEqual(mutationCalls(ambiguous), [])
  assertHoldOnlyTouchedSelectedRevisions(ambiguous, [])

  const foreign = makeFixture(t, {
    foreignActive: "app",
    appActive: true,
    scannerActive: true,
  })
  const foreignResult = foreign.run("--hold", {
    LYRA_TEST_FINALIZER_STATUS: "completed",
    LYRA_TEST_FINALIZER_CONCLUSION: "cancelled",
    LYRA_TEST_MAIN_SHA: "8".repeat(40),
  })
  assert.notEqual(foreignResult.status, 0)
  assert.equal(
    foreign.state().apps[appName].find((item) => item.name === "lyrashield-app--legacy").properties
      .active,
    true
  )
  assert.equal(
    foreign.state().apps[appName].find((item) => item.name === appCandidate).properties.active,
    false
  )
  assert.equal(
    foreign.state().apps[scannerName].find((item) => item.name === scannerCandidate).properties
      .active,
    false
  )
  assertHoldOnlyTouchedSelectedRevisions(foreign, [
    [appName, appCandidate],
    [scannerName, scannerCandidate],
  ])
})
