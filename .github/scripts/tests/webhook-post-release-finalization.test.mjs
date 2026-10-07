import assert from "node:assert/strict"
import test from "node:test"
import {
  assertPostReleaseProbe,
  assertPostReleaseRunHistory,
} from "../verify-webhook-post-release-finalization.mjs"

const expected = {
  originalRunId: "37516632066",
  originalOwner: "37516632066:1",
  originalSourceSha: "a".repeat(40),
  recoveryRunId: "37577700000",
  recoveryAttempt: "2",
  recoverySourceSha: "b".repeat(40),
  workerImage: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"c".repeat(64)}`,
  webImage: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:${"d".repeat(64)}`,
}
const original = {
  id: Number(expected.originalRunId),
  run_attempt: 1,
  head_sha: expected.originalSourceSha,
  head_branch: "main",
  path: ".github/workflows/release-production.yml",
  event: "push",
  status: "completed",
  conclusion: "failure",
}
const recovery = {
  id: Number(expected.recoveryRunId),
  run_attempt: Number(expected.recoveryAttempt),
  head_sha: expected.recoverySourceSha,
  head_branch: "main",
  path: ".github/workflows/recover-held-webhook-cutover.yml@main",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "failure",
}
const probe = [
  "WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED",
  `WEBHOOK_POST_RELEASE_ORIGINAL_OWNER=${expected.originalOwner}`,
  `WEBHOOK_POST_RELEASE_RECOVERY_RUN_ID=${expected.recoveryRunId}`,
  `WEBHOOK_POST_RELEASE_RECOVERY_ATTEMPT=${expected.recoveryAttempt}`,
  `WEBHOOK_POST_RELEASE_RECOVERY_SOURCE_SHA=${expected.recoverySourceSha}`,
  `WEBHOOK_POST_RELEASE_WORKER_IMAGE=${expected.workerImage}`,
  `WEBHOOK_POST_RELEASE_WEB_IMAGE=${expected.webImage}`,
].join("\n")

test("post-release run history binds the failed original and exact failed recovery attempt", () => {
  assert.doesNotThrow(() => assertPostReleaseRunHistory(original, recovery, expected))
  for (const change of [
    { run_attempt: 3 },
    { head_sha: "e".repeat(40) },
    { path: ".github/workflows/recover-held-webhook-cutover.yml@feature" },
    { status: "in_progress" },
    { conclusion: "success" },
  ]) {
    assert.throws(() => assertPostReleaseRunHistory(original, { ...recovery, ...change }, expected))
  }
  assert.throws(() =>
    assertPostReleaseRunHistory({ ...original, head_branch: "feature" }, recovery, expected)
  )
  assert.throws(() =>
    assertPostReleaseRunHistory({ ...original, run_attempt: 3 }, recovery, expected)
  )
  assert.throws(() =>
    assertPostReleaseRunHistory({ ...original, event: "workflow_dispatch" }, recovery, expected)
  )
  assert.throws(() =>
    assertPostReleaseRunHistory(
      { ...original, path: ".github/workflows/deploy-azure.yml" },
      recovery,
      expected
    )
  )
})

test("historical attempt proof remains valid when the run later has another attempt", () => {
  const latestRunAttempt = { ...recovery, run_attempt: 3, conclusion: "success" }
  assert.throws(() => assertPostReleaseRunHistory(original, latestRunAttempt, expected))
  assert.doesNotThrow(() => assertPostReleaseRunHistory(original, recovery, expected))
})

test("post-release VM proof rejects missing, duplicate and foreign identities", () => {
  assert.doesNotThrow(() => assertPostReleaseProbe(probe, expected))
  for (const changed of [
    probe.replace("WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED", ""),
    `${probe}\nWEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED`,
    `${probe}\nWEBHOOK_POST_RELEASE_RECOVERY_RUN_ID=1`,
    probe.replace(
      expected.workerImage,
      `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:${"e".repeat(64)}`
    ),
    probe.replace(expected.originalOwner, "37516632066:2"),
  ]) {
    assert.throws(() => assertPostReleaseProbe(changed, expected))
  }
})
