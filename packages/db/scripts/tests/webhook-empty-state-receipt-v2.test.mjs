import test from "node:test"
import assert from "node:assert/strict"
import {
  canonical,
  sha256,
  validateReceipt,
  QUEUES,
  STATES,
  WORKFLOW,
  CALLER,
  PREDICATE,
} from "../webhook-empty-state-receipt-v2.mjs"
import {
  verifyCertificateLinkage,
  validRunState,
  attestationArguments,
} from "../webhook-empty-state-attestation.mjs"
import { validateStartupProof } from "../../../../ops/worker/webhook-empty-state-startup-fence.mjs"
import { validateRootPolicyIntegrity } from "../webhook-empty-state-root-store.mjs"
const H = "a".repeat(64),
  S = "b".repeat(40),
  now = Date.parse("2026-10-05T09:01:00Z")
import { fixture } from "./webhook-empty-state-v2-fixture.mjs"
test("canonical receipt validates complete, fresh /3 evidence", () => {
  const { receipt, policy } = fixture()
  assert.match(validateReceipt(receipt, policy, now).receiptSha256, /^[a-f0-9]{64}$/)
  assert.equal(canonical({ z: 0, a: 1 }), '{"a":1,"z":0}')
})
for (const [name, mutate] of Object.entries({
  "caller verified flag": (r) => (r.evidence.verified = true),
  "missing app identity": (r) => delete r.evidence.database.app,
  "swapped app principal": (r) => (r.evidence.database.app.principalSha256 = "c".repeat(64)),
  "foreign admission": (r) => (r.evidence.redis.owner = "999:1"),
  "latent fix queue": (r) => (r.evidence.queues.fixGenerate.counts.paused = 1),
  scheduler: (r) => (r.evidence.queues.scan.schedulers = 1),
  "unknown state": (r) => (r.evidence.queues.scan.counts.unknown = 0),
  "old fallback": (r) =>
    (r.evidence.fallback = { ...r.evidence.fallback, protocol: "durable-claims/1" }),
  "wrong backup target": (r) =>
    (r.evidence.backup = { ...r.evidence.backup, databaseIdentitySha256: "c".repeat(64) }),
  "different restored object": (r) =>
    (r.evidence.restore = { ...r.evidence.restore, backupSha256: "c".repeat(64) }),
  "stale readback": (r) => (r.evidence.observedAt = "2026-10-05T08:59:00Z"),
  "reboot without fence": (r) => (r.evidence.worker.startupFenced = false),
  "unresolved parent": (r) => (r.evidence.unresolvedParents = 1),
  "wrong nonce": (r) => (r.authorization.nonce = "x".repeat(40)),
  "wrong source": (r) => (r.authorization.sourceSha = "c".repeat(40)),
  "wrong run": (r) => (r.authorization.runId = "999"),
  "expanded authorization": (r) => (r.authorization.expiresAt = "2026-10-05T10:00:00Z"),
}))
  test(`rejects ${name}`, () => {
    const { receipt, policy } = fixture()
    mutate(receipt)
    assert.throws(() => validateReceipt(receipt, policy, now))
  })
test("expired, disabled and revoked root policy fails", () => {
  const { receipt, policy } = fixture()
  for (const changed of [{ enabled: false }, { revoked: true }])
    assert.throws(() => validateReceipt(receipt, { ...policy, ...changed }, now))
  assert.throws(() => validateReceipt(receipt, policy, now + 30 * 60_000))
})
test("root policy digest binds the signed principal expectations", () => {
  const { policy } = fixture()
  delete policy.policySha256
  policy.policySha256 = sha256(canonical(policy))
  assert.equal(validateRootPolicyIntegrity(policy), true)
  const changed = structuredClone(policy)
  changed.databasePrincipals.system = "worker_runtime"
  assert.throws(() => validateRootPolicyIntegrity(changed), /digest mismatch/)
  const wrongPolicy = structuredClone(policy)
  delete wrongPolicy.policySha256
  wrongPolicy.databasePrincipals.system = "worker_runtime"
  wrongPolicy.policySha256 = sha256(canonical(wrongPolicy))
  assert.throws(() => validateRootPolicyIntegrity(wrongPolicy), /separate principal/)
  const migrationPolicy = structuredClone(policy)
  delete migrationPolicy.policySha256
  migrationPolicy.databasePrincipals.migration = migrationPolicy.databasePrincipals.worker
  migrationPolicy.policySha256 = sha256(canonical(migrationPolicy))
  assert.throws(() => validateRootPolicyIntegrity(migrationPolicy), /separate from runtime/)
  const { receipt, policy: receiptPolicy } = fixture()
  assert.throws(() => validateReceipt(receipt, migrationPolicy, now), /separate from runtime/)
  const wrongMigrationReceipt = structuredClone(receipt)
  wrongMigrationReceipt.evidence.database.migration.principalSha256 = sha256(
    receiptPolicy.databasePrincipals.worker
  )
  assert.throws(
    () => validateReceipt(wrongMigrationReceipt, receiptPolicy, now),
    /Missing or changed migration database identity/
  )
})
test("startup denies reboot before completion even for /2 candidate", () => {
  const { receipt, policy } = fixture()
  assert.throws(
    () =>
      validateStartupProof(
        { authorization: receipt.authorization, state: "stopped" },
        null,
        policy,
        "candidate",
        now
      ),
    /before migration/
  )
})
test("certificate authority fields bind source/signer/run independent of predicates", () => {
  const { receipt, policy } = fixture()
  const workflowBytes = "    environment: azure-production\n"
  policy.workflowFileSha256 = sha256(workflowBytes)
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryURI: "https://github.com/ecryptoguru/lyrashield-ai",
    sourceRepositoryIdentifier: "1286618458",
    sourceRepositoryOwnerIdentifier: "116722580",
    sourceRepositoryRef: "refs/heads/main",
    sourceRepositoryDigest: S,
    buildSignerDigest: S,
    buildSignerURI: `https://github.com/ecryptoguru/lyrashield-ai/${WORKFLOW}@${S}`,
    buildConfigURI: `https://github.com/ecryptoguru/lyrashield-ai/${CALLER}@refs/heads/main`,
    buildConfigDigest: S,
    buildTrigger: "workflow_dispatch",
    runInvocationURI: "https://github.com/ecryptoguru/lyrashield-ai/actions/runs/123/attempts/1",
    runnerEnvironment: "github-hosted",
  }
  const result = {
    verificationResult: {
      signature: { certificate },
      statement: {
        predicateType: PREDICATE,
        subject: [{ digest: { sha256: sha256(canonical(receipt)) } }],
        predicate: { verified: true },
      },
    },
  }
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: S,
    head_branch: "main",
    event: "workflow_dispatch",
    path: CALLER,
    repository: { id: 1286618458, owner: { id: 116722580 } },
    actor: { id: 42 },
    status: "in_progress",
    conclusion: null,
  }
  assert.equal(verifyCertificateLinkage(result, run, receipt, policy, workflowBytes), true)
  for (const field of [
    "issuer",
    "sourceRepositoryIdentifier",
    "sourceRepositoryOwnerIdentifier",
    "sourceRepositoryDigest",
    "buildSignerDigest",
    "buildSignerURI",
    "runInvocationURI",
    "buildTrigger",
  ]) {
    const changed = structuredClone(result)
    changed.verificationResult.signature.certificate[field] = "wrong"
    assert.throws(() => verifyCertificateLinkage(changed, run, receipt, policy, workflowBytes))
  }
  const changed = structuredClone(result)
  changed.verificationResult.statement.subject[0].digest.sha256 = "c".repeat(64)
  assert.throws(() => verifyCertificateLinkage(changed, run, receipt, policy, workflowBytes))
})
test("completed exact candidate can start; wrong image reference or digest cannot", () => {
  const { receipt, policy } = fixture()
  policy.images = { candidate: `ghcr.io/ecryptoguru/lyrashield-worker@sha256:${H}` }
  const proof = {
    schemaVersion: "webhook-empty-state-completion/v2",
    authorizationSha256: sha256(canonical(receipt.authorization)),
    receiptSha256: sha256(canonical(receipt)),
    sourceSha: S,
    databaseIdentitySha256: H,
    state: "complete",
    schemaSha256: H,
    historySha256: H,
    indexSha256: H,
    workerImageDigest: `sha256:${H}`,
  }
  const fence = {
    schemaVersion: "webhook-empty-state-fence/v2",
    authorization: receipt.authorization,
    state: "migration-complete",
    receiptSha256: proof.receiptSha256,
    completionSha256: sha256(canonical(proof)),
  }
  assert.equal(validateStartupProof(fence, proof, policy, policy.images.candidate, now), true)
  assert.throws(() =>
    validateStartupProof(fence, proof, policy, "ghcr.io/other/worker@sha256:" + H, now)
  )
  const wrong = { ...proof, workerImageDigest: "sha256:" + "c".repeat(64) }
  assert.throws(() =>
    validateStartupProof(
      { ...fence, completionSha256: sha256(canonical(wrong)) },
      wrong,
      policy,
      policy.images.candidate,
      now
    )
  )
})
test("self-consistent null identity templates never authorize", () => {
  const { receipt, policy } = fixture()
  policy.databaseIdentitySha256 = null
  policy.redisIdentitySha256 = null
  for (const connection of Object.values(receipt.evidence.database))
    connection.identitySha256 = null
  receipt.evidence.redis.identitySha256 = null
  assert.throws(() => validateReceipt(receipt, policy, now), /digest invalid/)
})
test("authenticated run states are explicitly allowlisted", () => {
  assert.equal(validRunState({ status: "in_progress", conclusion: null }), true)
  assert.equal(validRunState({ status: "completed", conclusion: "success" }), true)
  for (const conclusion of [
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    "failure",
    "cancelled",
    "neutral",
    "skipped",
    null,
  ])
    assert.equal(validRunState({ status: "completed", conclusion }), false)
  for (const status of ["queued", "waiting", "requested", "unknown"])
    assert.equal(validRunState({ status, conclusion: null }), false)
})
test("official verifier CLI arguments omit conflicting signer identity and custom roots", () => {
  const { receipt, policy } = fixture()
  const args = attestationArguments("/fixed/root/receipt.json", receipt, policy)
  assert.equal(args.includes("--signer-workflow"), true)
  assert.equal(args.includes("--signer-digest"), true)
  for (const rejected of [
    "--cert-identity",
    "--cert-identity-regex",
    "--custom-trusted-root",
    "--bundle",
  ])
    assert.equal(args.includes(rejected), false)
})
test("live observations between SQL phases reject changed admission or revived writers", () => {
  for (const mutate of [
    (r) => (r.evidence.redis.owner = "999:1"),
    (r) => (r.evidence.redis.valueSha256 = "c".repeat(64)),
    (r) => (r.evidence.writers[0].revisions[0].active = true),
    (r) => (r.evidence.queues.fixGenerate.counts.delayed = 1),
    (r) => (r.evidence.unknownWriters = 1),
  ]) {
    const { receipt, policy } = fixture()
    assert.match(validateReceipt(receipt, policy, now).authorizationSha256, /^[a-f0-9]{64}$/)
    const live = structuredClone(receipt)
    mutate(live)
    assert.throws(() => validateReceipt(live, policy, now))
  }
})

test("mocked drain-to-completion-to-startup-to-release handoff binds one authorization", async () => {
  const { advancePhase, PHASES, verifyCompletionProof, releaseOwnedMaintenance } =
    await import("../../../../ops/worker/webhook-empty-state-phases.mjs")
  const { schedulingObservation } =
    await import("../../../../ops/worker/webhook-empty-state-observer.mjs")
  const { ownedAdmission } =
    await import("../../../../ops/worker/webhook-empty-state-admission.mjs")
  const { receipt, policy } = fixture()
  policy.images = {
    candidate: `ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${policy.candidate.imageDigest}`,
  }
  const stop = canonical({
    operator: "github-actions",
    reason: "webhook-empty-state",
    owner: receipt.authorization.owner,
  })
  let redisValue = null
  const redis = {
    eval: async (script, keys, key, raw) => {
      assert.equal(keys, 1)
      assert.equal(key, "lyrashield:scan-admission:stopped")
      if (script.includes("'SET'")) {
        if (redisValue && redisValue !== raw) return 0
        redisValue = raw
        return 1
      }
      if (redisValue !== raw) return 0
      if (script.includes("'DEL'")) redisValue = null
      return 1
    },
  }
  let state
  let completion, fence
  for (const phase of PHASES) {
    state = advancePhase(state, phase, receipt.authorization, policy, now)
    if (phase === "admission") await ownedAdmission("claim", stop, redis)
    if (phase === "drain") {
      const queues = Object.fromEntries(
        QUEUES.map((name) => [
          name,
          {
            getJobCounts: async (...states) => Object.fromEntries(states.map((s) => [s, 0])),
            getJobSchedulersCount: async () => 0,
            getRepeatableJobs: async () => [],
          },
        ])
      )
      const observed = await schedulingObservation(
        {
          query: async () => ({
            rows: [{ scans: "0", handlers: "0", tracks: "0", parents: "0", writers: "0" }],
          }),
        },
        queues
      )
      Object.assign(receipt.evidence, observed)
    }
    if (["stop", "collect", "migrate", "complete", "candidate"].includes(phase))
      await ownedAdmission("assert", stop, redis)
    if (phase === "collect" || phase === "migrate") validateReceipt(receipt, policy, now)
    if (phase === "complete") {
      completion = {
        schemaVersion: "webhook-empty-state-completion/v2",
        state: "complete",
        authorizationSha256: sha256(canonical(receipt.authorization)),
        receiptSha256: sha256(canonical(receipt)),
        sourceSha: policy.sourceSha,
        databaseIdentitySha256: policy.databaseIdentitySha256,
        workerImageDigest: policy.candidate.imageDigest,
        schemaSha256: H,
        historySha256: H,
        indexSha256: H,
      }
      verifyCompletionProof(completion, receipt, {
        status: "complete",
        sourceSha: policy.sourceSha,
        runId: policy.runId,
      })
      fence = {
        schemaVersion: "webhook-empty-state-fence/v2",
        state: "migration-complete",
        authorization: receipt.authorization,
        receiptSha256: completion.receiptSha256,
        completionSha256: sha256(canonical(completion)),
      }
    }
    if (phase === "candidate")
      validateStartupProof(fence, completion, policy, policy.images.candidate, now)
    if (phase === "resume") {
      let persisted = false
      await releaseOwnedMaintenance({
        release: () => ownedAdmission("release", stop, redis),
        checkPublicReadiness: () => assert.equal(redisValue, null),
        recheckAuthorization: () =>
          advancePhase(state, "resume", receipt.authorization, policy, now),
        persistCompletion: () => {
          persisted = true
        },
        cleanupOwnedFence: () => {
          assert.equal(persisted, false)
          fence = null
        },
        restoreOwnedHold: () => ownedAdmission("claim", stop, redis),
      })
    }
  }
  assert.equal(redisValue, null)
  assert.equal(fence, null)
  assert.equal(state.phase, "resume")
  assert.equal(state.authorizationSha256, sha256(canonical(receipt.authorization)))
})

test("whole workflow replay output contract returns the original collect digest at every later phase", async () => {
  const { advancePhase, PHASES, replayPhaseOutput } =
    await import("../../../../ops/worker/webhook-empty-state-phases.mjs")
  const { receipt, policy } = fixture()
  let state
  for (const durable of PHASES) {
    state = advancePhase(state, durable, receipt.authorization, policy, now)
    for (const phase of PHASES.slice(0, PHASES.indexOf(durable) + 1)) {
      const output = replayPhaseOutput(phase, state, receipt.authorization, policy, receipt, now)
      assert.equal(output.split("\n").includes(`EMPTY_STATE_PHASE_COMPLETE=${phase}`), true)
      if (phase === "collect") {
        const digests = output.split("\n").filter((line) => /^[a-f0-9]{64}$/.test(line))
        assert.deepEqual(digests, [sha256(canonical(receipt))])
      }
    }
    if (PHASES.indexOf(durable) >= PHASES.indexOf("collect"))
      assert.throws(() =>
        replayPhaseOutput(
          "collect",
          state,
          receipt.authorization,
          { ...policy, revoked: true },
          receipt,
          now
        )
      )
  }
})
