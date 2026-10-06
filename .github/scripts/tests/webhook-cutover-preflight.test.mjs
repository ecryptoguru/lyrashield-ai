import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  receiptStateFromProbe,
  selectPreflightAction,
} from "../verify-webhook-cutover-preflight.mjs"

const sourceSha = "a".repeat(40)
const advancedSha = "b".repeat(40)
const helperPath = path.resolve(".github/scripts/verify-webhook-cutover-preflight.mjs")

test("same-run verified receipt preserves first-cutover mode after main advances", () => {
  assert.equal(
    selectPreflightAction({
      runAttempt: 2,
      sourceSha,
      latestMainSha: advancedSha,
      retryReceiptState: "verified",
    }),
    "reuse-first-cutover"
  )
})

test("same-main retry without receipt repeats the read-only baseline classifier", () => {
  assert.equal(
    selectPreflightAction({
      runAttempt: 2,
      sourceSha,
      latestMainSha: sourceSha,
      retryReceiptState: "absent",
    }),
    "classify-baseline"
  )
})

test("stale-source retry without receipt fails closed", () => {
  assert.throws(
    () =>
      selectPreflightAction({
        runAttempt: 2,
        sourceSha,
        latestMainSha: advancedSha,
        retryReceiptState: "absent",
      }),
    /no owned cutover receipt authorizes this retry/
  )
})

test("ambiguous retry receipt fails closed even when source remains current", () => {
  assert.throws(
    () =>
      selectPreflightAction({
        runAttempt: 2,
        sourceSha,
        latestMainSha: sourceSha,
        retryReceiptState: "ambiguous",
      }),
    /receipt state is ambiguous/
  )
})

test("first attempt requires current main before classifying", () => {
  assert.throws(
    () =>
      selectPreflightAction({
        runAttempt: 1,
        sourceSha,
        latestMainSha: advancedSha,
        retryReceiptState: "not-applicable",
      }),
    /no owned cutover receipt authorizes this retry/
  )
})

test("probe accepts exactly one receipt marker", () => {
  assert.equal(
    receiptStateFromProbe("prefix\nWEBHOOK_RECOVERY_RECEIPT_VERIFIED\nsuffix"),
    "verified"
  )
  assert.equal(receiptStateFromProbe("WEBHOOK_RECOVERY_RECEIPT_ABSENT"), "absent")
  assert.throws(
    () =>
      receiptStateFromProbe("WEBHOOK_RECOVERY_RECEIPT_VERIFIED\nWEBHOOK_RECOVERY_RECEIPT_ABSENT"),
    /ambiguous/
  )
  assert.throws(
    () =>
      receiptStateFromProbe("WEBHOOK_RECOVERY_RECEIPT_VERIFIED\nWEBHOOK_RECOVERY_RECEIPT_VERIFIED"),
    /ambiguous/
  )
})

function executable(directory, name, body) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!${process.execPath}\n${body}`)
  chmodSync(file, 0o755)
}

function fixture(
  t,
  {
    attempt = "2",
    latestMain = sourceSha,
    probeOutput = "WEBHOOK_RECOVERY_RECEIPT_ABSENT\n",
    topology = "app-and-scanner",
  } = {}
) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-cutover-preflight-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, "github-output")
  const envCapture = path.join(directory, "probe-env.json")
  const classifierEnvCapture = path.join(directory, "classifier-env.json")
  const classifierCalled = path.join(directory, "classifier-called")
  writeFileSync(outputPath, "")
  executable(
    directory,
    "git",
    `const args=process.argv.slice(2); if(args.join(" ")==="rev-parse HEAD") console.log(${JSON.stringify(sourceSha)}); else process.exit(2);`
  )
  executable(
    directory,
    "bash",
    `const fs=require("node:fs"); const args=process.argv.slice(2); if(args.join(" ")!==".github/scripts/webhook-claims-maintenance.sh recovery-probe") process.exit(2); const required=["RG","WORKER_VM_NAME","LYRASHIELD_ADMISSION_STOP_OWNER","LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID"]; if(required.some(name=>!process.env[name] && !(name==="AZURE_SCANNER_CONTAINER_APP_NAME" && process.env.AZURE_WEBHOOK_WRITER_TOPOLOGY==="app-only"))) { console.error("required recovery-probe environment missing"); process.exit(41); } fs.writeFileSync(${JSON.stringify(envCapture)},JSON.stringify(Object.fromEntries([...required,"DEPLOY_SHA"].map(name=>[name,process.env[name]])))); process.stdout.write(process.env.PROBE_OUTPUT??"");`
  )
  executable(
    directory,
    "gh",
    `const args=process.argv.slice(2); if(args[0]!=="api" || !process.env.GH_TOKEN || process.env.GITHUB_REPOSITORY!=="ecryptoguru/lyrashield-ai") process.exit(2); console.log(${JSON.stringify(latestMain)});`
  )
  executable(
    directory,
    "node",
    `const fs=require("node:fs"); const args=process.argv.slice(2); const required=["AZURE_WEBHOOK_WRITER_TOPOLOGY","AZURE_RESOURCE_GROUP","AZURE_APP_CONTAINER_APP_NAME","AZURE_SCANNER_CONTAINER_APP_NAME","AZURE_WORKER_VM_NAME","AZURE_KEY_VAULT_NAME","GHCR_USERNAME"]; if(args[0]!==".github/scripts/verify-webhook-cutover.mjs" || args[1]!=="--github-output" || args[2]!==process.env.GITHUB_OUTPUT || required.some(name=>!process.env[name] && !(name==="AZURE_SCANNER_CONTAINER_APP_NAME" && process.env.AZURE_WEBHOOK_WRITER_TOPOLOGY==="app-only"))) process.exit(2); fs.writeFileSync(${JSON.stringify(classifierEnvCapture)},JSON.stringify(Object.fromEntries(required.map(name=>[name,process.env[name]])))); fs.writeFileSync(${JSON.stringify(classifierCalled)},"called"); fs.appendFileSync(args[2],"webhook_claims_cutover=false\\n");`
  )

  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    DEPLOY_SHA: sourceSha,
    GITHUB_REPOSITORY: "ecryptoguru/lyrashield-ai",
    GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_OUTPUT: outputPath,
    GH_TOKEN: "fixture-token",
    RG: "fixture-rg",
    WORKER_VM_NAME: "fixture-worker",
    LYRASHIELD_ADMISSION_STOP_OWNER: `123:${attempt}`,
    LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID: "123",
    AZURE_RESOURCE_GROUP: "fixture-rg",
    AZURE_APP_CONTAINER_APP_NAME: "fixture-app",
    AZURE_WEBHOOK_WRITER_TOPOLOGY: topology,
    AZURE_SCANNER_CONTAINER_APP_NAME: topology === "app-only" ? "" : "fixture-scanner",
    AZURE_WORKER_VM_NAME: "fixture-worker",
    AZURE_KEY_VAULT_NAME: "fixture-kv",
    GHCR_USERNAME: "fixture-owner",
    PROBE_OUTPUT: probeOutput,
  }
  const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", env })
  return { result, outputPath, envCapture, classifierEnvCapture, classifierCalled }
}

test("verified retry probe receives required environment and preserves cutover without classifier", (t) => {
  const f = fixture(t, {
    latestMain: advancedSha,
    probeOutput: "WEBHOOK_RECOVERY_RECEIPT_VERIFIED\n",
  })
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(f.envCapture, "utf8")), {
    RG: "fixture-rg",
    WORKER_VM_NAME: "fixture-worker",
    LYRASHIELD_ADMISSION_STOP_OWNER: "123:2",
    LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID: "123",
    DEPLOY_SHA: sourceSha,
  })
  assert.match(readFileSync(f.outputPath, "utf8"), /webhook_claims_cutover=true/)
  assert.match(readFileSync(f.outputPath, "utf8"), /webhook_cutover_retry_receipt=verified/)
  assert.throws(() => readFileSync(f.classifierCalled), { code: "ENOENT" })
})

test("absent receipt on current main forwards verifier environment and output path", (t) => {
  const f = fixture(t)
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.equal(readFileSync(f.classifierCalled, "utf8"), "called")
  assert.deepEqual(JSON.parse(readFileSync(f.classifierEnvCapture, "utf8")), {
    AZURE_RESOURCE_GROUP: "fixture-rg",
    AZURE_APP_CONTAINER_APP_NAME: "fixture-app",
    AZURE_WEBHOOK_WRITER_TOPOLOGY: "app-and-scanner",
    AZURE_SCANNER_CONTAINER_APP_NAME: "fixture-scanner",
    AZURE_WORKER_VM_NAME: "fixture-worker",
    AZURE_KEY_VAULT_NAME: "fixture-kv",
    GHCR_USERNAME: "fixture-owner",
  })
  assert.match(readFileSync(f.outputPath, "utf8"), /webhook_claims_cutover=false/)
})

test("stale source with absent receipt and conflicting markers fail before classification", (t) => {
  const stale = fixture(t, {
    latestMain: advancedSha,
    probeOutput: "WEBHOOK_RECOVERY_RECEIPT_ABSENT\n",
  })
  assert.notEqual(stale.result.status, 0)
  assert.equal(readFileSync(stale.outputPath, "utf8"), "")
  assert.throws(() => readFileSync(stale.classifierCalled), { code: "ENOENT" })

  const conflict = fixture(t, {
    probeOutput: "WEBHOOK_RECOVERY_RECEIPT_VERIFIED\nWEBHOOK_RECOVERY_RECEIPT_ABSENT\n",
  })
  assert.notEqual(conflict.result.status, 0)
  assert.equal(readFileSync(conflict.outputPath, "utf8"), "")
  assert.throws(() => readFileSync(conflict.classifierCalled), { code: "ENOENT" })
})

test("explicit app-only topology reaches the classifier without a scanner name", (t) => {
  const f = fixture(t, { topology: "app-only" })
  assert.equal(f.result.status, 0, f.result.stderr)
  const captured = JSON.parse(readFileSync(f.classifierEnvCapture, "utf8"))
  assert.equal(captured.AZURE_WEBHOOK_WRITER_TOPOLOGY, "app-only")
  assert.equal(captured.AZURE_SCANNER_CONTAINER_APP_NAME, "")
})
