import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { verifyCandidateReceipt, verifyPreparedRun } from "../verify-webhook-recovery-candidate.mjs"
import { workerImageRehearsalHarnessSha } from "../worker-image-rehearsal-harness-sha.mjs"

const sourceSha = "a".repeat(40)
const engineRevision = "b".repeat(40)
const runId = "37555500000"
const runAttempt = 2
const repository = "ecryptoguru/lyrashield-ai"
const sha = (char) => `sha256:${char.repeat(64)}`
const image = (name, char) => `ghcr.io/${repository}/${name}@${sha(char)}`
const rehearsalHarnessSha = workerImageRehearsalHarnessSha()
const run = {
  id: Number(runId),
  run_attempt: runAttempt,
  head_sha: sourceSha,
  head_branch: "main",
  path: ".github/workflows/prepare-worker-recovery-candidate.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
}
const receipt = {
  schemaVersion: 2,
  sourceSha,
  engineRevision,
  runId,
  runAttempt,
  rehearsal: {
    harnessSha: rehearsalHarnessSha,
    harnessRevision: sourceSha,
  },
  images: {
    web: image("lyrashield-web", "c"),
    worker: image("lyrashield-worker", "d"),
    egressProxy: image("lyrashield-egress-proxy", "e"),
  },
}
const expected = {
  repository,
  runId,
  runAttempt,
  sourceSha,
  engineRevision,
  rehearsalHarnessSha,
  rehearsalHarnessRevision: sourceSha,
}

test("prepared run is a successful manual build of the exact main source", () => {
  assert.equal(verifyPreparedRun(run, expected), runAttempt)
  assert.equal(verifyPreparedRun({ ...run, path: `${run.path}@main` }, expected), runAttempt)
  assert.equal(
    verifyPreparedRun({ ...run, path: `${run.path}@refs/heads/main` }, expected),
    runAttempt
  )
  for (const change of [
    { id: Number(runId) + 1 },
    { head_sha: "f".repeat(40) },
    { head_branch: "feature" },
    { path: ".github/workflows/deploy-azure.yml" },
    { path: ".github/workflows/prepare-worker-recovery-candidate.yml@feature" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 0 },
  ]) {
    assert.throws(() => verifyPreparedRun({ ...run, ...change }, expected))
  }
})

test("candidate receipt yields only canonical immutable image digests", () => {
  assert.deepEqual(verifyCandidateReceipt(receipt, expected), {
    web_image: `ghcr.io/${repository}/lyrashield-web`,
    web_digest: sha("c"),
    worker_image: `ghcr.io/${repository}/lyrashield-worker`,
    worker_digest: sha("d"),
    egress_proxy_image: `ghcr.io/${repository}/lyrashield-egress-proxy`,
    egress_proxy_digest: sha("e"),
    engine_revision: engineRevision,
    prepared_source_sha: sourceSha,
    worker_rehearsal_harness_sha: rehearsalHarnessSha,
    worker_rehearsal_harness_revision: sourceSha,
  })
  assert.equal(
    verifyCandidateReceipt(receipt, { ...expected, engineRevision: null }).engine_revision,
    engineRevision
  )
  for (const changed of [
    { ...receipt, schemaVersion: 1 },
    { ...receipt, sourceSha: "f".repeat(40) },
    { ...receipt, engineRevision: "f".repeat(40) },
    { ...receipt, runId: "37555500001" },
    { ...receipt, runAttempt: 1 },
    { ...receipt, rehearsal: { ...receipt.rehearsal, harnessSha: sha("f") } },
    {
      ...receipt,
      rehearsal: { ...receipt.rehearsal, harnessRevision: "f".repeat(40) },
    },
    { ...receipt, rehearsal: { ...receipt.rehearsal, extra: true } },
    { ...receipt, extra: true },
    { ...receipt, images: { ...receipt.images, extra: "ref" } },
    { ...receipt, images: { ...receipt.images, worker: image("other-worker", "d") } },
    {
      ...receipt,
      images: { ...receipt.images, worker: `ghcr.io/${repository}/lyrashield-worker:mutable` },
    },
    {
      ...receipt,
      images: { ...receipt.images, worker: `ghcr.io/${repository}/lyrashield-worker@sha256:short` },
    },
  ]) {
    assert.throws(() => verifyCandidateReceipt(changed, expected))
  }
  assert.throws(() =>
    verifyCandidateReceipt(
      { ...receipt, engineRevision: "mutable" },
      { ...expected, engineRevision: null }
    )
  )
  assert.throws(() =>
    verifyCandidateReceipt(receipt, { ...expected, rehearsalHarnessSha: sha("f") })
  )
})

test("prepared artifact is read as one bounded ZIP receipt and mismatches fail closed", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-prepared-candidate-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, "output")
  const zipPath = path.join(directory, "artifact.zip")
  writeFileSync(path.join(directory, "recovery-candidate-receipt.json"), JSON.stringify(receipt))
  const zipped = spawnSync("zip", ["-q", zipPath, "recovery-candidate-receipt.json"], {
    cwd: directory,
    encoding: "utf8",
  })
  assert.equal(zipped.status, 0, zipped.stderr)
  const ghPath = path.join(directory, "gh")
  writeFileSync(
    ghPath,
    `#!${process.execPath}\nconst fs=require("node:fs"); const resource=process.argv[3]; if(resource.includes("/git/ref/heads/main")) process.stdout.write(process.env.MOCK_MAIN); else if(resource.endsWith("/actions/runs/${runId}")) process.stdout.write(process.env.MOCK_RUN); else if(resource.includes("/artifacts?")) process.stdout.write(process.env.MOCK_LIST); else if(resource.endsWith("/artifacts/42/zip")) process.stdout.write(fs.readFileSync(process.env.MOCK_ZIP)); else process.exit(2);\n`
  )
  chmodSync(ghPath, 0o755)
  const artifactDigest = `sha256:${createHash("sha256").update(readFileSync(zipPath)).digest("hex")}`
  const list = {
    total_count: 1,
    artifacts: [
      {
        id: 42,
        name: `webhook-recovery-candidate-${sourceSha}`,
        expired: false,
        digest: artifactDigest,
        workflow_run: { id: Number(runId) },
      },
    ],
  }
  const baseEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: outputPath,
    DEPLOY_SHA: sourceSha,
    ENGINE_REVISION: engineRevision,
    LYRASHIELD_WEBHOOK_RECOVERY_PREPARED_RUN_ID: runId,
    MOCK_MAIN: JSON.stringify({ object: { sha: sourceSha } }),
    MOCK_RUN: JSON.stringify(run),
    MOCK_LIST: JSON.stringify(list),
    MOCK_ZIP: zipPath,
  }
  const invoke = (overrides = {}, args = []) => {
    writeFileSync(outputPath, "")
    return spawnSync(
      process.execPath,
      [path.resolve(".github/scripts/verify-webhook-recovery-candidate.mjs"), ...args],
      {
        env: { ...baseEnv, ...overrides },
        encoding: "utf8",
      }
    )
  }
  const accepted = invoke()
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(readFileSync(outputPath, "utf8"), new RegExp(`worker_digest=${sha("d")}`))
  assert.match(
    readFileSync(outputPath, "utf8"),
    new RegExp(`worker_rehearsal_harness_sha=${rehearsalHarnessSha}`)
  )
  assert.match(readFileSync(outputPath, "utf8"), new RegExp(`prepared_run_attempt=${runAttempt}`))
  assert.match(
    readFileSync(outputPath, "utf8"),
    new RegExp(`prepared_artifact_digest=${artifactDigest}`)
  )
  const historical = invoke(
    { MOCK_MAIN: JSON.stringify({ object: { sha: "f".repeat(40) } }), ENGINE_REVISION: "" },
    ["--historical-finalization"]
  )
  assert.equal(historical.status, 0, historical.stderr)
  for (const overrides of [
    { MOCK_MAIN: JSON.stringify({ object: { sha: "f".repeat(40) } }) },
    { MOCK_RUN: JSON.stringify({ ...run, conclusion: "failure" }) },
    { MOCK_LIST: JSON.stringify({ ...list, artifacts: [...list.artifacts, ...list.artifacts] }) },
    {
      MOCK_LIST: JSON.stringify({
        ...list,
        artifacts: [{ ...list.artifacts[0], digest: sha("f") }],
      }),
    },
    {
      MOCK_LIST: JSON.stringify({
        ...list,
        artifacts: [{ ...list.artifacts[0], workflow_run: { id: 1 } }],
      }),
    },
  ]) {
    const rejected = invoke(overrides)
    assert.notEqual(rejected.status, 0)
    assert.equal(readFileSync(outputPath, "utf8"), "")
  }
  writeFileSync(path.join(directory, "unexpected.txt"), "extra")
  const expanded = spawnSync("zip", ["-q", zipPath, "unexpected.txt"], {
    cwd: directory,
    encoding: "utf8",
  })
  assert.equal(expanded.status, 0, expanded.stderr)
  const expandedDigest = `sha256:${createHash("sha256").update(readFileSync(zipPath)).digest("hex")}`
  const extraFile = invoke({
    MOCK_LIST: JSON.stringify({
      ...list,
      artifacts: [{ ...list.artifacts[0], digest: expandedDigest }],
    }),
  })
  assert.notEqual(extraFile.status, 0)
  assert.equal(readFileSync(outputPath, "utf8"), "")
})
