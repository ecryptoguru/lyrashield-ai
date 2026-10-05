import test from "node:test"
import assert from "node:assert/strict"
import { canonical, sha256, validateReceipt, QUEUES, STATES, WORKFLOW, CALLER, PREDICATE } from "../webhook-empty-state-receipt-v2.mjs"
import { verifyCertificateLinkage } from "../webhook-empty-state-attestation.mjs"
import { validateStartupProof } from "../../../../ops/worker/webhook-empty-state-startup-fence.mjs"
const H = "a".repeat(64), S = "b".repeat(40), now = Date.parse("2026-10-05T09:01:00Z")
function fixture() {
  const authorization = { sourceSha: S, runId: "123", originalAttempt: 1, owner: "123:1", nonce: "n".repeat(40), issuedAt: "2026-10-05T09:00:00Z", expiresAt: "2026-10-05T09:30:00Z", policySha256: H, producerSha256: H, workflowSha: S, repositoryId: "1286618458", ownerId: "116722580" }
  const image = { imageDigest: `sha256:${H}`, sourceSha: S, engineRevision: S, protocol: "durable-claims/2", rehearsalRunId: "122", rehearsalSha256: H }
  const backup = { objectIdSha256: H, versionId: "etag:123", encryptedSha256: H, dumpSha256: H, databaseIdentitySha256: H, createdAt: "2026-10-05T08:00:00Z", runId: "120" }
  const restore = { backupSha256: sha256(canonical(backup)), runId: "120", completedAt: "2026-10-05T08:30:00Z", schemaSha256: H, auditSha256: H, readinessSha256: H }
  const resources = Object.fromEntries(["app", "scanner", "worker", "system", "migration", "backup"].map(name => [name, `/fixed/${name}`]))
  const credentials = Object.fromEntries([...Object.keys(resources), "redis"].map(name => [name, H]))
  const policy = { ...authorization, enabled: true, revoked: false, databaseIdentitySha256: H, resources, credentials, redisIdentitySha256: H, admissionValueSha256: H, candidate: image, fallback: image, backup, restore, actorId: "42" }
  const observedAt = new Date(now).toISOString()
  const receipt = { schemaVersion: "webhook-empty-state/v2", mode: "empty-scheduling", authorization, evidence: {
    observedAt, database: Object.fromEntries(Object.entries(resources).map(([name, resourceId]) => [name, { identitySha256: H, credentialSha256: H, resourceId, observedAt }])),
    redis: { identitySha256: H, credentialSha256: H, owner: "123:1", valueSha256: H }, writers: ["app", "scanner"].map(name => ({ resourceId: resources[name], revisions: [{ name: "old", active: false, replicas: 0 }] })),
    worker: { imageDigest: `sha256:${H}`, sourceSha: S, engineRevision: S, serviceState: "inactive", timerState: "inactive", containers: 0, stopOwner: "123:1", stopAt: observedAt, stopProofSha256: H, startupFenced: true },
    queues: Object.fromEntries(QUEUES.map(name => [name, { counts: Object.fromEntries(STATES.map(state => [state, 0])), schedulers: 0, repeats: 0 }])), nonterminalScans: 0, inFlightHandlers: 0, trackRows: 0, unresolvedParents: 0, candidate: image, fallback: image, backup, restore,
  } }
  return { receipt, policy }
}
test("canonical receipt validates complete, fresh /2 evidence", () => { const { receipt, policy } = fixture(); assert.match(validateReceipt(receipt, policy, now).receiptSha256, /^[a-f0-9]{64}$/); assert.equal(canonical({ z: 0, a: 1 }), '{"a":1,"z":0}') })
for (const [name, mutate] of Object.entries({
  "caller verified flag": r => r.evidence.verified = true,
  "missing app identity": r => delete r.evidence.database.app,
  "foreign admission": r => r.evidence.redis.owner = "999:1",
  "latent fix queue": r => r.evidence.queues.fixGenerate.counts.paused = 1,
  "scheduler": r => r.evidence.queues.scan.schedulers = 1,
  "unknown state": r => r.evidence.queues.scan.counts.unknown = 0,
  "old fallback": r => r.evidence.fallback = { ...r.evidence.fallback, protocol: "durable-claims/1" },
  "wrong backup target": r => r.evidence.backup = { ...r.evidence.backup, databaseIdentitySha256: "c".repeat(64) },
  "different restored object": r => r.evidence.restore = { ...r.evidence.restore, backupSha256: "c".repeat(64) },
  "stale readback": r => r.evidence.observedAt = "2026-10-05T08:59:00Z",
  "reboot without fence": r => r.evidence.worker.startupFenced = false,
  "unresolved parent": r => r.evidence.unresolvedParents = 1,
  "wrong nonce": r => r.authorization.nonce = "x".repeat(40),
  "wrong source": r => r.authorization.sourceSha = "c".repeat(40),
  "wrong run": r => r.authorization.runId = "999",
  "expanded authorization": r => r.authorization.expiresAt = "2026-10-05T10:00:00Z",
})) test(`rejects ${name}`, () => { const { receipt, policy } = fixture(); mutate(receipt); assert.throws(() => validateReceipt(receipt, policy, now)) })
test("expired, disabled and revoked root policy fails", () => { const { receipt, policy } = fixture(); for (const changed of [{ enabled: false }, { revoked: true }]) assert.throws(() => validateReceipt(receipt, { ...policy, ...changed }, now)); assert.throws(() => validateReceipt(receipt, policy, now + 30 * 60_000)) })
test("startup denies reboot before completion even for /2 candidate", () => { const { receipt, policy } = fixture(); assert.throws(() => validateStartupProof({ authorization: receipt.authorization, state: "stopped" }, null, policy, "candidate", now), /before migration/) })
test("certificate authority fields bind source/signer/run independent of predicates", () => {
  const { receipt, policy } = fixture(); const workflowBytes = "    environment: azure-production\n"; policy.workflowFileSha256 = sha256(workflowBytes)
  const certificate = { issuer: "https://token.actions.githubusercontent.com", sourceRepositoryURI: "https://github.com/ecryptoguru/lyrashield-ai", sourceRepositoryIdentifier: "1286618458", sourceRepositoryOwnerIdentifier: "116722580", sourceRepositoryRef: "refs/heads/main", sourceRepositoryDigest: S, buildSignerDigest: S, buildSignerURI: `https://github.com/ecryptoguru/lyrashield-ai/${WORKFLOW}@${S}`, buildConfigURI: `https://github.com/ecryptoguru/lyrashield-ai/${CALLER}@refs/heads/main`, buildConfigDigest: S, buildTrigger: "workflow_dispatch", runInvocationURI: "https://github.com/ecryptoguru/lyrashield-ai/actions/runs/123/attempts/1", runnerEnvironment: "github-hosted" }
  const result = { verificationResult: { signature: { certificate }, statement: { predicateType: PREDICATE, subject: [{ digest: { sha256: sha256(canonical(receipt)) } }], predicate: { verified: true } } } }
  const run = { id: 123, run_attempt: 1, head_sha: S, head_branch: "main", event: "workflow_dispatch", path: CALLER, repository: { id: 1286618458, owner: { id: 116722580 } }, actor: { id: 42 } }
  assert.equal(verifyCertificateLinkage(result, run, receipt, policy, workflowBytes), true)
  for (const field of ["issuer", "sourceRepositoryIdentifier", "sourceRepositoryOwnerIdentifier", "sourceRepositoryDigest", "buildSignerDigest", "buildSignerURI", "runInvocationURI", "buildTrigger"]) { const changed = structuredClone(result); changed.verificationResult.signature.certificate[field] = "wrong"; assert.throws(() => verifyCertificateLinkage(changed, run, receipt, policy, workflowBytes)) }
  const changed = structuredClone(result); changed.verificationResult.statement.subject[0].digest.sha256 = "c".repeat(64); assert.throws(() => verifyCertificateLinkage(changed, run, receipt, policy, workflowBytes))
})
