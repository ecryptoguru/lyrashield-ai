import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const RUN_ID = /^[1-9][0-9]*$/

function requireKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} has unexpected or missing fields`)
  }
}

export function verifyPreparedRun(run, { runId, sourceSha }) {
  if (
    !Number.isSafeInteger(Number(runId)) ||
    run?.id !== Number(runId) ||
    run.head_sha !== sourceSha ||
    run.head_branch !== "main" ||
    ![
      ".github/workflows/prepare-worker-recovery-candidate.yml",
      ".github/workflows/prepare-worker-recovery-candidate.yml@main",
      ".github/workflows/prepare-worker-recovery-candidate.yml@refs/heads/main",
    ].includes(run.path) ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  ) {
    throw new Error("Prepared candidate run is not the successful main-source build")
  }
  return run.run_attempt
}

export function verifyCandidateReceipt(
  receipt,
  { repository, runId, runAttempt, sourceSha, engineRevision }
) {
  requireKeys(
    receipt,
    ["schemaVersion", "sourceSha", "engineRevision", "runId", "runAttempt", "images"],
    "Candidate receipt"
  )
  requireKeys(receipt.images, ["web", "worker", "egressProxy"], "Candidate images")
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sourceSha !== sourceSha ||
    (engineRevision
      ? receipt.engineRevision !== engineRevision
      : !SHA.test(receipt.engineRevision)) ||
    String(receipt.runId) !== runId ||
    receipt.runAttempt !== runAttempt
  ) {
    throw new Error("Candidate receipt does not bind the requested source, engine and run")
  }
  const outputs = {}
  for (const [key, image] of [
    ["web", "lyrashield-web"],
    ["worker", "lyrashield-worker"],
    ["egressProxy", "lyrashield-egress-proxy"],
  ]) {
    const base = `ghcr.io/${repository}/${image}`
    const ref = receipt.images[key]
    if (typeof ref !== "string" || !ref.startsWith(`${base}@`)) {
      throw new Error("Candidate image repository does not match the release repository")
    }
    const digest = ref.slice(base.length + 1)
    if (!DIGEST.test(digest)) throw new Error("Candidate image is not pinned by a sha256 digest")
    const outputKey = key === "egressProxy" ? "egress_proxy" : key
    outputs[`${outputKey}_image`] = base
    outputs[`${outputKey}_digest`] = digest
  }
  outputs.engine_revision = receipt.engineRevision
  return outputs
}

function ghApi(resource, options = {}) {
  return execFileSync("gh", ["api", resource], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    ...options,
  })
}

function main() {
  const historicalFinalization = process.argv[2] === "--historical-finalization"
  if (process.argv.length !== (historicalFinalization ? 3 : 2)) {
    throw new Error("Unknown recovery candidate verifier argument")
  }
  const runId = process.env.LYRASHIELD_WEBHOOK_RECOVERY_PREPARED_RUN_ID ?? ""
  const sourceSha = process.env.DEPLOY_SHA ?? ""
  const engineRevision = process.env.ENGINE_REVISION ?? ""
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  const outputPath = process.env.GITHUB_OUTPUT ?? ""
  if (
    !RUN_ID.test(runId) ||
    !SHA.test(sourceSha) ||
    (!historicalFinalization && !SHA.test(engineRevision)) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) ||
    !outputPath
  ) {
    throw new Error("Prepared candidate verification context is incomplete")
  }
  if (!historicalFinalization) {
    const currentMain = JSON.parse(ghApi(`repos/${repository}/git/ref/heads/main`))
    if (currentMain?.object?.sha !== sourceSha) {
      throw new Error("Prepared recovery source is no longer current main")
    }
  }
  const run = JSON.parse(ghApi(`repos/${repository}/actions/runs/${runId}`))
  const runAttempt = verifyPreparedRun(run, { runId, sourceSha })
  const name = `webhook-recovery-candidate-${sourceSha}`
  const artifactList = JSON.parse(
    ghApi(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`)
  )
  if (
    !Number.isSafeInteger(artifactList?.total_count) ||
    artifactList.total_count > 100 ||
    !Array.isArray(artifactList.artifacts)
  ) {
    throw new Error("Prepared candidate artifact inventory is incomplete")
  }
  const matches = artifactList.artifacts.filter((artifact) => artifact.name === name)
  if (
    matches.length !== 1 ||
    matches[0].expired ||
    !Number.isSafeInteger(matches[0].id) ||
    !DIGEST.test(matches[0].digest ?? "") ||
    matches[0].workflow_run?.id !== Number(runId)
  ) {
    throw new Error("Prepared candidate artifact is absent or ambiguous")
  }
  const directory = mkdtempSync(path.join(tmpdir(), "lyrashield-recovery-candidate-"))
  try {
    const zipPath = path.join(directory, "candidate.zip")
    const zip = ghApi(`repos/${repository}/actions/artifacts/${matches[0].id}/zip`)
    if (`sha256:${createHash("sha256").update(zip).digest("hex")}` !== matches[0].digest) {
      throw new Error("Prepared candidate artifact digest does not match GitHub's record")
    }
    writeFileSync(zipPath, zip, { mode: 0o600 })
    const listing = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
    }).trim()
    if (listing !== "recovery-candidate-receipt.json") {
      throw new Error("Prepared candidate artifact must contain exactly one receipt")
    }
    const raw = execFileSync("unzip", ["-p", zipPath, listing], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    })
    const outputs = verifyCandidateReceipt(JSON.parse(raw), {
      repository,
      runId,
      runAttempt,
      sourceSha,
      engineRevision: historicalFinalization ? null : engineRevision,
    })
    for (const [key, value] of Object.entries(outputs)) {
      appendFileSync(outputPath, `${key}=${value}\n`)
    }
    console.log(
      "Verified immutable prepared recovery candidate images from the successful offline run."
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
