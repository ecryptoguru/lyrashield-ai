import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const RUN_ID = /^[1-9][0-9]*$/
const ATTEMPT = /^[1-9][0-9]*$/
const SHA = /^[a-f0-9]{40}$/
const IMAGE =
  /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/lyrashield-(?:web|worker)@sha256:[a-f0-9]{64}$/

function runPathMatches(path, name) {
  return [name, `${name}@main`, `${name}@refs/heads/main`].includes(path)
}

export function assertPostReleaseRunHistory(original, recovery, expected) {
  const originalPath = ".github/workflows/release-production.yml"
  const recoveryPath = ".github/workflows/recover-held-webhook-cutover.yml"
  const valid = (run, runId, sourceSha, path) =>
    run?.id === Number(runId) &&
    run.head_sha === sourceSha &&
    run.head_branch === "main" &&
    runPathMatches(run.path, path) &&
    run.status === "completed" &&
    ["failure", "cancelled"].includes(run.conclusion)
  if (
    !valid(original, expected.originalRunId, expected.originalSourceSha, originalPath) ||
    original.run_attempt !== Number(expected.originalOwner.split(":")[1]) ||
    original.event !== "push" ||
    !valid(recovery, expected.recoveryRunId, expected.recoverySourceSha, recoveryPath) ||
    recovery.event !== "workflow_dispatch" ||
    recovery.run_attempt !== Number(expected.recoveryAttempt)
  ) {
    throw new Error("Original or target recovery GitHub run does not match finalization scope")
  }
}

export function assertPostReleaseProbe(probe, expected) {
  const lines = probe.split(/\r?\n/)
  const exactly = (marker) => {
    if (lines.filter((line) => line === marker).length !== 1) {
      throw new Error("Post-release VM proof is missing or ambiguous")
    }
  }
  exactly("WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED")
  for (const [key, value] of [
    ["WEBHOOK_POST_RELEASE_ORIGINAL_OWNER", expected.originalOwner],
    ["WEBHOOK_POST_RELEASE_RECOVERY_RUN_ID", expected.recoveryRunId],
    ["WEBHOOK_POST_RELEASE_RECOVERY_ATTEMPT", expected.recoveryAttempt],
    ["WEBHOOK_POST_RELEASE_RECOVERY_SOURCE_SHA", expected.recoverySourceSha],
    ["WEBHOOK_POST_RELEASE_WORKER_IMAGE", expected.workerImage],
    ["WEBHOOK_POST_RELEASE_WEB_IMAGE", expected.webImage],
  ]) {
    exactly(`${key}=${value}`)
    if (lines.filter((line) => line.startsWith(`${key}=`)).length !== 1) {
      throw new Error("Post-release VM proof contains conflicting identity")
    }
  }
}

function gh(resource) {
  return JSON.parse(
    execFileSync("gh", ["api", resource], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    })
  )
}

function context() {
  const originalRunId = process.env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID ?? ""
  const originalOwner = process.env.LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER ?? ""
  const originalSourceSha = process.env.LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA ?? ""
  const recoveryRunId = process.env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID ?? ""
  const recoveryAttempt = process.env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT ?? ""
  const recoverySourceSha = process.env.LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA ?? ""
  const finalizerRunId = process.env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_RUN_ID ?? ""
  const finalizerAttempt = process.env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_ATTEMPT ?? ""
  const finalizerSourceSha = process.env.LYRASHIELD_WEBHOOK_CUTOVER_FINALIZER_SOURCE_SHA ?? ""
  const workerImage = process.env.LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WORKER_IMAGE ?? ""
  const webImage = process.env.LYRASHIELD_WEBHOOK_CUTOVER_PREPARED_WEB_IMAGE ?? ""
  if (
    !RUN_ID.test(originalRunId) ||
    !RUN_ID.test(recoveryRunId) ||
    !RUN_ID.test(finalizerRunId) ||
    !ATTEMPT.test(recoveryAttempt) ||
    !ATTEMPT.test(finalizerAttempt) ||
    !SHA.test(originalSourceSha) ||
    !SHA.test(recoverySourceSha) ||
    !SHA.test(finalizerSourceSha) ||
    originalOwner !== `${originalRunId}:${originalOwner.split(":")[1]}` ||
    !ATTEMPT.test(originalOwner.split(":")[1] ?? "") ||
    new Set([originalRunId, recoveryRunId, finalizerRunId]).size !== 3 ||
    finalizerRunId !== process.env.GITHUB_RUN_ID ||
    finalizerAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    finalizerSourceSha !== process.env.DEPLOY_SHA
  ) {
    throw new Error("Post-release finalization identity is incomplete or inconsistent")
  }
  return {
    originalRunId,
    originalOwner,
    originalSourceSha,
    recoveryRunId,
    recoveryAttempt,
    recoverySourceSha,
    finalizerRunId,
    finalizerAttempt,
    finalizerSourceSha,
    workerImage,
    webImage,
  }
}

function main() {
  const mode = process.argv[2]
  if (!["--run-metadata", "--probe"].includes(mode) || process.argv.length !== 3) {
    throw new Error("Unknown post-release finalization verifier mode")
  }
  const expected = context()
  if (mode === "--probe") {
    if (
      !IMAGE.test(expected.workerImage) ||
      !IMAGE.test(expected.webImage) ||
      !expected.workerImage.includes("/lyrashield-worker@") ||
      !expected.webImage.includes("/lyrashield-web@")
    ) {
      throw new Error("Post-release prepared image refs are invalid")
    }
    assertPostReleaseProbe(readFileSync(0, "utf8"), expected)
    console.log("Post-release VM proof is bound to the exact original and recovery identities.")
    return
  }
  const repository = process.env.GITHUB_REPOSITORY ?? ""
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository identity is missing")
  }
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (
    checkout !== expected.finalizerSourceSha ||
    gh(`repos/${repository}/git/ref/heads/main`)?.object?.sha !== expected.finalizerSourceSha
  ) {
    throw new Error("Finalization operations checkout is not exact current main")
  }
  const original = gh(
    `repos/${repository}/actions/runs/${expected.originalRunId}/attempts/${expected.originalOwner.split(":")[1]}`
  )
  const recovery = gh(
    `repos/${repository}/actions/runs/${expected.recoveryRunId}/attempts/${expected.recoveryAttempt}`
  )
  assertPostReleaseRunHistory(original, recovery, expected)
  console.log("Validated exact original and historical recovery GitHub run metadata.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
