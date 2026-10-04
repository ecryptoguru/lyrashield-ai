import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const validate = path.resolve(".github/scripts/validate-webhook-deploy-dispatch.sh")
const normalize = path.resolve(".github/scripts/normalize-worker-image-reference.sh")
const currentSha = "a".repeat(40)
const staleSha = "b".repeat(40)

function dispatch(t, options) {
  const directory = mkdtempSync(path.join(tmpdir(), "ls-webhook-dispatch-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const gh = path.join(directory, "gh")
  const source =
    "#!/usr/bin/env node\n" +
    "const target = process.argv[3] || '';\n" +
    "if (target.includes('/git/ref/heads/main')) console.log(" +
    JSON.stringify(options.latestMain) +
    ");\n" +
    "else if (target.endsWith('/attempts/1/jobs')) console.log(" +
    JSON.stringify(options.original ?? "success") +
    ");\n" +
    "else process.exit(2);\n"
  writeFileSync(gh, source)
  chmodSync(gh, 0o755)
  const output = path.join(directory, "github-output")
  const sourceSha = options.sourceSha
  const cutover = options.cutover ?? "true"
  const result = spawnSync("bash", [validate], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory + path.delimiter + process.env.PATH,
      SOURCE_SHA: sourceSha,
      CONFIRMATION:
        (cutover === "false" ? "deploy" : "webhook-cutover") + ":" + sourceSha,
      WEBHOOK_CLAIMS_CUTOVER: cutover,
      GITHUB_REPOSITORY: "ecryptoguru/lyrashield-ai",
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: options.attempt ?? "1",
      GITHUB_OUTPUT: output,
    },
  })
  let outputText = ""
  try {
    outputText = readFileSync(output, "utf8")
  } catch {
    outputText = ""
  }
  return { ...result, outputText }
}

test("fresh cutover dispatch rejects a source SHA that is no longer current main", (t) => {
  const result = dispatch(t, { sourceSha: staleSha, latestMain: currentSha })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /may only target current main/)
})

test("same-run rerun accepts the original immutable source only after successful original validation", (t) => {
  const result = dispatch(t, {
    sourceSha: staleSha,
    latestMain: currentSha,
    attempt: "2",
    original: "success",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.outputText, /recovery_requires_receipt=true/)
})

test("same-run rerun rejects source recovery when the original dispatch was not validated", (t) => {
  const result = dispatch(t, {
    sourceSha: staleSha,
    latestMain: currentSha,
    attempt: "2",
    original: "failure",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /successful original dispatch validation/)
})

test("current-main cutover dispatch succeeds without setting recovery state", (t) => {
  const result = dispatch(t, { sourceSha: currentSha, latestMain: currentSha })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.outputText, /recovery_requires_receipt=false/)
})

test("stale ordinary deployment remains rejected, including on a later run attempt", (t) => {
  const result = dispatch(t, {
    sourceSha: staleSha,
    latestMain: currentSha,
    attempt: "2",
    cutover: "false",
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /may only target current main/)
})

test("digest-only and tag-plus-digest worker image references normalize to the canonical GHCR digest", () => {
  const repo = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker"
  const digest = "sha256:" + "c".repeat(64)
  for (const input of [repo + "@" + digest, repo + ":latest@" + digest]) {
    const result = spawnSync("bash", [normalize, input, "ecryptoguru/lyrashield-ai"], {
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), repo + "@" + digest)
  }
})

test("worker image normalization rejects foreign repositories and malformed digests", () => {
  const digest = "sha256:" + "c".repeat(64)
  for (const input of [
    "ghcr.io/attacker/lyrashield-ai/lyrashield-worker@" + digest,
    "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:bad",
    "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker:bad tag@" + digest,
  ]) {
    const result = spawnSync("bash", [normalize, input, "ecryptoguru/lyrashield-ai"], {
      encoding: "utf8",
    })
    assert.notEqual(result.status, 0)
  }
})
