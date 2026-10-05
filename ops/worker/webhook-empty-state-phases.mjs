// Pure phase rules shared by the fixed privileged controller and negative tests.
import {
  requireValue,
  canonical,
  sha256,
  validateAuthorization,
} from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
export const PHASES = [
  "preflight",
  "admission",
  "drain",
  "stop",
  "collect",
  "migrate",
  "complete",
  "candidate",
  "resume",
]
export function advancePhase(state, phase, authorization, policy, now = Date.now()) {
  const authorizationSha256 = validateAuthorization(authorization, policy, now)
  requireValue(PHASES.includes(phase), "Unknown phase")
  if (!state) {
    requireValue(phase === "preflight", "Recovery requires owned original state")
    return {
      schemaVersion: "webhook-empty-state-progress/v2",
      authorizationSha256,
      authorization,
      phase,
      lastAttempt: authorization.originalAttempt,
    }
  }
  requireValue(
    state.schemaVersion === "webhook-empty-state-progress/v2" &&
      state.authorizationSha256 === authorizationSha256 &&
      canonical(state.authorization) === canonical(authorization),
    "Recovery changed immutable source/owner/nonce/window"
  )
  const previous = PHASES.indexOf(state.phase),
    next = PHASES.indexOf(phase)
  requireValue(
    previous >= 0 && (next === previous || next === previous + 1),
    "Phase skipped or legacy rollback requested"
  )
  return { ...state, phase }
}
export function verifyCompletionProof(proof, receipt, result) {
  requireValue(
    result.status === "complete" &&
      result.sourceSha === receipt.authorization.sourceSha &&
      result.runId === receipt.authorization.runId,
    "Atomic runner did not complete on exact source/run"
  )
  requireValue(
    proof.authorizationSha256 === sha256(canonical(receipt.authorization)) &&
      proof.receiptSha256 === sha256(canonical(receipt)) &&
      proof.databaseIdentitySha256 === receipt.evidence.database.migration.identitySha256,
    "Completion proof identity changed"
  )
  for (const field of ["schemaSha256", "historySha256", "indexSha256"])
    requireValue(/^[a-f0-9]{64}$/.test(proof[field] || ""), "Missing schema/index/history readback")
  return true
}
