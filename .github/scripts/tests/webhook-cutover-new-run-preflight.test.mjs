import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  assertOriginalCutoverRun,
  recoveryIdentityFromProbe,
} from "../verify-webhook-cutover-preflight.mjs"

const original = {
  runId: "37516632066",
  owner: "37516632066:1",
  sourceSha: "a".repeat(40),
}
const candidateSha = "b".repeat(40)
const originalRun = {
  id: Number(original.runId),
  head_sha: original.sourceSha,
  head_branch: "main",
  path: ".github/workflows/deploy-azure.yml",
  status: "completed",
  conclusion: "failure",
}
const validProbe = [
  "WEBHOOK_NEW_RUN_RECOVERY_VERIFIED",
  `WEBHOOK_RECOVERY_OWNER=${original.owner}`,
  `WEBHOOK_RECOVERY_OWNER_RUN_ID=${original.runId}`,
  `WEBHOOK_RECOVERY_OWNER_SOURCE_SHA=${original.sourceSha}`,
].join("\n")

test("new-run probe binds exact original run, owner and source", () => {
  assert.deepEqual(recoveryIdentityFromProbe(validProbe, original), original)
  for (const probe of [
    validProbe.replace("WEBHOOK_NEW_RUN_RECOVERY_VERIFIED", "WEBHOOK_RECOVERY_RECEIPT_ABSENT"),
    validProbe.replace("WEBHOOK_NEW_RUN_RECOVERY_VERIFIED", "WEBHOOK_SAME_RUN_CUTOVER_VERIFIED"),
    `${validProbe}\nWEBHOOK_RECOVERY_RECEIPT_ABSENT`,
    `${validProbe}\nWEBHOOK_RECOVERY_RECEIPT_VERIFIED`,
    `${validProbe}\nWEBHOOK_NEW_RUN_RECOVERY_VERIFIED`,
    `${validProbe}\nWEBHOOK_RECOVERY_OWNER=${original.owner}`,
    validProbe.replace(original.owner, "37516632066:2"),
    validProbe.replace(original.sourceSha, "c".repeat(40)),
  ]) {
    assert.throws(() => recoveryIdentityFromProbe(probe, original))
  }
})

test("original GitHub run must be the completed, failed main cutover source", () => {
  assert.doesNotThrow(() => assertOriginalCutoverRun(originalRun, original))
  assert.doesNotThrow(() =>
    assertOriginalCutoverRun({ ...originalRun, path: `${originalRun.path}@main` }, original)
  )
  assert.doesNotThrow(() =>
    assertOriginalCutoverRun(
      { ...originalRun, path: `${originalRun.path}@refs/heads/main` },
      original
    )
  )
  for (const change of [
    { id: 37516632067 },
    { head_sha: candidateSha },
    { head_branch: "feature" },
    { path: ".github/workflows/another.yml" },
    { path: ".github/workflows/deploy-azure.yml@feature" },
    { status: "in_progress" },
    { conclusion: "success" },
  ]) {
    assert.throws(() => assertOriginalCutoverRun({ ...originalRun, ...change }, original))
  }
})

function executable(directory, name, body) {
  const file = path.join(directory, name)
  writeFileSync(file, `#!${process.execPath}\n${body}`)
  chmodSync(file, 0o755)
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-new-run-recovery-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, "github-output")
  const probeCapture = path.join(directory, "probe-called")
  writeFileSync(outputPath, "")
  executable(
    directory,
    "git",
    'if(process.argv.slice(2).join(" ")!=="rev-parse HEAD") process.exit(2); console.log(process.env.MOCK_CHECKOUT_SHA);'
  )
  executable(
    directory,
    "gh",
    'const args=process.argv.slice(2); if(args[0]!=="api") process.exit(2); if(args[1].endsWith("/git/ref/heads/main")) console.log(process.env.MOCK_MAIN_SHA); else if(args[1].endsWith("/actions/runs/37516632066")) console.log(process.env.MOCK_ORIGINAL_RUN); else process.exit(2);'
  )
  executable(
    directory,
    "bash",
    `const fs=require("node:fs"); if(process.argv.slice(2).join(" ")!==".github/scripts/webhook-claims-maintenance.sh recovery-probe-new-run") process.exit(2); fs.writeFileSync(${JSON.stringify(probeCapture)},"called"); console.log(process.env.MOCK_PROBE);`
  )
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    DEPLOY_SHA: candidateSha,
    GITHUB_REPOSITORY: "ecryptoguru/lyrashield-ai",
    GITHUB_RUN_ID: "37520000000",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: outputPath,
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID: original.runId,
    LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER: original.owner,
    LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA: original.sourceSha,
    MOCK_CHECKOUT_SHA: candidateSha,
    MOCK_MAIN_SHA: candidateSha,
    MOCK_ORIGINAL_RUN: JSON.stringify(originalRun),
    MOCK_PROBE: validProbe,
    ...overrides,
  }
  const result = spawnSync(
    process.execPath,
    [path.resolve(".github/scripts/verify-webhook-cutover-preflight.mjs"), "--new-run-recovery"],
    { encoding: "utf8", env }
  )
  return { result, outputPath, probeCapture }
}

test("new-run preflight writes only the verified original identity", (t) => {
  const f = fixture(t)
  assert.equal(f.result.status, 0, f.result.stderr)
  assert.equal(readFileSync(f.probeCapture, "utf8"), "called")
  assert.equal(
    readFileSync(f.outputPath, "utf8"),
    `held_recovery_original_run_id=${original.runId}\nheld_recovery_original_owner=${original.owner}\nheld_recovery_original_source_sha=${original.sourceSha}\nheld_recovery_verified=true\n`
  )
})

test("stale candidate and mismatched original scope fail before recovery output", (t) => {
  for (const overrides of [
    { MOCK_MAIN_SHA: "c".repeat(40) },
    { LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER: "37516632066:2" },
    { LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA: "c".repeat(40) },
    { GITHUB_RUN_ID: original.runId },
    { MOCK_ORIGINAL_RUN: JSON.stringify({ ...originalRun, conclusion: "success" }) },
  ]) {
    const f = fixture(t, overrides)
    assert.notEqual(f.result.status, 0)
    assert.equal(readFileSync(f.outputPath, "utf8"), "")
  }
})
