import { spawnSync } from "node:child_process"
import {
  canonical,
  sha256,
  requireValue,
  REPOSITORY,
  REPOSITORY_ID,
  OWNER_ID,
  WORKFLOW,
  CALLER,
  PREDICATE,
} from "./webhook-empty-state-receipt-v2.mjs"

function gh(args) {
  const result = spawnSync("/usr/bin/gh", args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2_000_000,
    env: { PATH: "/usr/bin:/bin", HOME: "/root", GH_HOST: "github.com" },
  })
  requireValue(result.status === 0, "Authenticated GitHub or official Sigstore verification failed")
  return JSON.parse(result.stdout)
}
export function validRunState(run) {
  return (
    (run.status === "in_progress" && run.conclusion === null) ||
    (run.status === "completed" && run.conclusion === "success")
  )
}
export function verifyCertificateLinkage(result, run, receipt, policy, workflowBytes) {
  const authorization = receipt.authorization
  const cert = result?.verificationResult?.signature?.certificate
  requireValue(cert, "Missing verified certificate")
  const expected = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryURI: `https://github.com/${REPOSITORY}`,
    sourceRepositoryIdentifier: REPOSITORY_ID,
    sourceRepositoryOwnerIdentifier: OWNER_ID,
    sourceRepositoryRef: "refs/heads/main",
    sourceRepositoryDigest: authorization.sourceSha,
    buildSignerDigest: policy.workflowSha,
    buildSignerURI: `https://github.com/${REPOSITORY}/${WORKFLOW}@${policy.workflowSha}`,
    buildConfigURI: `https://github.com/${REPOSITORY}/${CALLER}@refs/heads/main`,
    buildConfigDigest: authorization.sourceSha,
    buildTrigger: "workflow_dispatch",
    runInvocationURI: `https://github.com/${REPOSITORY}/actions/runs/${authorization.runId}/attempts/${run.run_attempt}`,
    runnerEnvironment: "github-hosted",
  }
  for (const [field, value] of Object.entries(expected))
    requireValue(cert[field] === value, `Wrong certificate ${field}`)
  requireValue(
    String(run.id) === authorization.runId &&
      Number(run.run_attempt) >= authorization.originalAttempt &&
      run.head_sha === authorization.sourceSha &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      run.path === CALLER &&
      String(run.repository?.id) === REPOSITORY_ID &&
      String(run.repository?.owner?.id) === OWNER_ID &&
      validRunState(run),
    "Authenticated run linkage mismatch"
  )
  // The immutable reusable workflow fixes environment: azure-production. Fulcio
  // has no environment extension; do not invent one or trust predicate fields.
  requireValue(
    typeof workflowBytes === "string" &&
      sha256(workflowBytes) === policy.workflowFileSha256 &&
      /^    environment: azure-production$/m.test(workflowBytes),
    "Pinned protected workflow content unavailable"
  )
  requireValue(
    String(run.actor?.id) === policy.actorId,
    "Original run actor differs from root authorization"
  )
  const statement = result.verificationResult.statement
  requireValue(
    statement?.predicateType === PREDICATE &&
      statement.subject?.length === 1 &&
      statement.subject[0].digest?.sha256 === sha256(canonical(receipt)),
    "Wrong canonical receipt subject"
  )
  // Predicate fields are public and user-controlled; never use them as authority.
  return true
}
export function attestationArguments(receiptPath, receipt, policy) {
  return [
    "attestation",
    "verify",
    receiptPath,
    "--repo",
    REPOSITORY,
    "--signer-workflow",
    `${REPOSITORY}/${WORKFLOW}`,
    "--signer-digest",
    policy.workflowSha,
    "--source-digest",
    receipt.authorization.sourceSha,
    "--source-ref",
    "refs/heads/main",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--predicate-type",
    PREDICATE,
    "--format",
    "json",
  ]
}
export function verifyAttestation(receiptPath, receipt, policy) {
  const results = gh(attestationArguments(receiptPath, receipt, policy))
  const run = gh(["api", `repos/${REPOSITORY}/actions/runs/${receipt.authorization.runId}`])
  const file = gh(["api", `repos/${REPOSITORY}/contents/${WORKFLOW}?ref=${policy.workflowSha}`])
  const workflowBytes = Buffer.from(file.content || "", "base64").toString("utf8")
  requireValue(Array.isArray(results) && results.length > 0, "No trusted attestation")
  for (const result of results) {
    try {
      return verifyCertificateLinkage(result, run, receipt, policy, workflowBytes)
    } catch {}
  }
  throw new Error("No attestation matches protected run and exact receipt")
}
