// Disposable-only canonical issuance rehearsal. Never import any collector or mutator.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import assert from "node:assert/strict"
import { fixture } from "../packages/db/scripts/tests/webhook-empty-state-v2-fixture.mjs"
import {
  canonical,
  sha256,
  validateAuthorization,
  validateReceipt,
  REPOSITORY,
  WORKFLOW,
} from "../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
import {
  verifyAttestation,
  attestationArguments,
  verifyCertificateLinkage,
} from "../packages/db/scripts/webhook-empty-state-attestation.mjs"
export async function main() {
  assert.ok(["prepare", "verify"].includes(process.argv[2]), "Exact disposable mode required")
  const dir = process.env.RUNNER_TEMP,
    receiptPath = dir + "/disposable-receipt.json",
    policyPath = dir + "/disposable-policy.json"
  if (process.argv[2] === "prepare") {
    assert.equal(process.env.GITHUB_ACTOR_ID, "116722580")
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1")
    assert.equal(process.env.DISPOSABLE_NONCE, "disposable-only-public-fixture-nonce-0000000000")
    assert.ok(
      Date.now() >= Date.parse("2026-10-05T07:34:00Z") &&
        Date.now() < Date.parse("2026-10-05T09:00:00Z"),
      "Approved disposable issuance window expired"
    )
    assert.equal(process.env.GITHUB_REF, "refs/heads/main")
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch")
    const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
    endpoint.searchParams.set("audience", "sigstore")
    const response = await fetch(endpoint, {
      headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    })
    assert.equal(response.ok, true)
    const token = (await response.json()).value
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    assert.equal(claims.repository, REPOSITORY)
    assert.equal(claims.ref, "refs/heads/main")
    assert.equal(claims.sha, process.env.GITHUB_SHA)
    assert.equal(
      claims.job_workflow_ref,
      REPOSITORY + "/" + WORKFLOW + "@" + claims.job_workflow_sha
    )
    assert.match(claims.job_workflow_sha, /^[a-f0-9]{40}$/)
    process.env.WORKFLOW_SHA = claims.job_workflow_sha
    const { receipt, policy } = buildSyntheticReceipt({
      sourceSha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      originalAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      workflowSha: process.env.WORKFLOW_SHA,
      actorId: process.env.GITHUB_ACTOR_ID,
      workflowBytes: readFileSync(WORKFLOW, "utf8"),
    })
    writeFileSync(
      dir + "/disposable-manifest.json",
      canonical({
        syntheticOnly: true,
        sourceSha: receipt.authorization.sourceSha,
        runId: receipt.authorization.runId,
        originalAttempt: receipt.authorization.originalAttempt,
        workflowSha: policy.workflowSha,
        actorId: policy.actorId,
        issuedAt: receipt.authorization.issuedAt,
        expiresAt: receipt.authorization.expiresAt,
        receiptSha256: sha256(canonical(receipt)),
        workflowFileSha256: policy.workflowFileSha256,
      })
    )
    writeFileSync(receiptPath, canonical(receipt), { mode: 0o600 })
    writeFileSync(policyPath, canonical(policy), { mode: 0o600 })
    writeFileSync(
      dir + "/disposable-predicate.json",
      canonical({ receiptSha256: sha256(canonical(receipt)) })
    )
    appendFileSync(
      process.env.GITHUB_ENV,
      "DISPOSABLE_RECEIPT_SHA256=" + sha256(canonical(receipt)) + "\n"
    )
  } else {
    const receipt = JSON.parse(readFileSync(receiptPath)),
      policy = JSON.parse(readFileSync(policyPath))
    validateReceipt(receipt, policy)
    // Actual discovery/official trust root + all application linkage gates; no mock.
    let passed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        assert.equal(verifyAttestation(receiptPath, receipt, policy), true)
        passed = true
        break
      } catch (error) {
        if (attempt === 19) throw error
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    assert.equal(passed, true)
    const gh = (args) => {
      const r = spawnSync("/usr/bin/gh", args, {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: "/root", GH_HOST: "github.com" },
      })
      assert.equal(r.status, 0)
      return JSON.parse(r.stdout)
    }
    const results = gh(attestationArguments(receiptPath, receipt, policy)),
      run = gh(["api", `repos/${REPOSITORY}/actions/runs/${receipt.authorization.runId}`]),
      bytes = readFileSync(WORKFLOW, "utf8")
    const valid = results.find((result) => {
      try {
        return verifyCertificateLinkage(result, run, receipt, policy, bytes)
      } catch {
        return false
      }
    })
    assert.ok(valid)
    // Mutate independently after actual verified result; signed identity/run fields
    // remain fixed, exercising the production linkage checks rather than a fake cert.
    for (const mutate of [
      (p) => (p.policy.workflowSha = "0".repeat(40)),
      (p) => (p.receipt.authorization.sourceSha = "0".repeat(40)),
      (p) => (p.receipt.authorization.runId = "1"),
      (p) => p.run.run_attempt++,
      (p) => (p.policy.actorId = "1"),
      (p) => (p.receipt.authorization.nonce += "X"),
      (p) => (p.result.verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64)),
      (p) =>
        (p.result.verificationResult.signature.certificate.sourceRepositoryURI =
          "https://github.com/disposable/wrong"),
    ]) {
      const p = structuredClone({ result: valid, run, receipt, policy })
      mutate(p)
      assert.throws(() => verifyCertificateLinkage(p.result, p.run, p.receipt, p.policy, bytes))
    }
    // Root authorization separately rejects receipt nonce mutation even without cert.
    validateAuthorization(receipt.authorization, policy)
    const changed = structuredClone(receipt.authorization)
    changed.nonce += "X"
    assert.throws(() => validateAuthorization(changed, policy))
    writeFileSync(
      dir + "/disposable-verification.json",
      canonical({
        syntheticOnly: true,
        receiptSha256: sha256(canonical(receipt)),
        runId: receipt.authorization.runId,
        workflowSha: policy.workflowSha,
        actualVerifyAttestationPassed: true,
        linkageNegatives: [
          "workflow",
          "source",
          "run",
          "attempt",
          "actor",
          "nonce",
          "digest",
          "repository",
        ],
        authorizationNonceNegativePassed: true,
        productionAuthorized: false,
      })
    )
    console.log("Disposable exact application verification passed; production remains disabled")
  }
}
export function buildSyntheticReceipt(
  { sourceSha, runId, originalAttempt, workflowSha, actorId, workflowBytes },
  now = Date.now()
) {
  const { receipt, policy } = fixture(),
    issuedAt = new Date(now).toISOString()
  Object.assign(receipt.authorization, {
    sourceSha,
    runId,
    originalAttempt,
    owner: runId + ":" + originalAttempt,
    workflowSha,
    nonce: "disposable-only-public-fixture-nonce-0000000000",
    issuedAt,
    expiresAt: new Date(now + 600000).toISOString(),
  })
  Object.assign(policy, receipt.authorization, {
    actorId,
    workflowFileSha256: sha256(workflowBytes),
  })
  receipt.evidence.observedAt = issuedAt
  for (const connection of Object.values(receipt.evidence.database))
    connection.observedAt = issuedAt
  receipt.evidence.redis.owner = receipt.authorization.owner
  receipt.evidence.worker.stopOwner = receipt.authorization.owner
  receipt.evidence.worker.stopAt = issuedAt
  receipt.evidence.backup.createdAt = new Date(now - 7200000).toISOString()
  receipt.evidence.restore.completedAt = new Date(now - 3600000).toISOString()
  receipt.evidence.restore.backupSha256 = sha256(canonical(receipt.evidence.backup))
  validateReceipt(receipt, policy, now)
  return { receipt, policy }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
