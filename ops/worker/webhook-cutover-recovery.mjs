import { createHash } from "node:crypto"

const sha40 = /^[a-f0-9]{40}$/
const imageDigest = /^.+@sha256:([a-f0-9]{64})$/
const recoveryLimit = 8

function fail(message) {
  throw new Error(message)
}

function validateOriginalReceipt(receipt, { allowCompleted = false } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    fail("Invalid webhook cutover receipt")

  const owner = /^([0-9]+):([1-9][0-9]*)$/.exec(receipt.owner ?? "")
  if (
    !owner ||
    receipt.runId !== owner[1] ||
    !sha40.test(receipt.productRevision ?? "") ||
    typeof receipt.admissionStopValue !== "string" ||
    (!allowCompleted && receipt.phase === "completed")
  )
    fail("Invalid original webhook cutover identity")

  let stop
  try {
    stop = JSON.parse(receipt.admissionStopValue)
  } catch {
    fail("Invalid original webhook admission stop")
  }
  if (
    stop?.operator !== "github-actions" ||
    stop.reason !== "webhook-claims-cutover" ||
    stop.owner !== receipt.owner ||
    stop.runId !== receipt.runId ||
    stop.productRevision !== receipt.productRevision
  )
    fail("Original webhook admission stop identity mismatch")

  const attempts = receipt.attempts
  const lastAttempt = receipt.lastAttempt
  const ownerAttempt = Number(owner[2])
  if (
    !Number.isSafeInteger(lastAttempt) ||
    !Array.isArray(attempts) ||
    attempts.length === 0 ||
    !attempts.every(
      (value, index) =>
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= lastAttempt &&
        (index === 0 || value > attempts[index - 1]),
    ) ||
    new Set(attempts).size !== attempts.length ||
    attempts[0] !== ownerAttempt ||
    !attempts.includes(lastAttempt) ||
    Math.max(...attempts) !== lastAttempt
  )
    fail("Invalid original webhook cutover attempt history")

  for (const key of ["databaseUrlSha256", "databaseSystemUrlSha256", "redisUrlSha256"])
    if (!/^[a-f0-9]{64}$/.test(receipt[key] ?? "")) fail("Invalid cutover connection identity")

  return { ownerRunId: owner[1], ownerSourceSha: receipt.productRevision }
}

export function assertOriginalWebhookCutoverReceipt(receipt, expected = {}) {
  const identity = validateOriginalReceipt(receipt)
  if (
    (expected.ownerRunId !== undefined && identity.ownerRunId !== expected.ownerRunId) ||
    (expected.ownerSourceSha !== undefined && identity.ownerSourceSha !== expected.ownerSourceSha) ||
    (expected.owner !== undefined && receipt.owner !== expected.owner)
  )
    fail("Original webhook cutover owner identity changed")
  return identity
}

export function assertHeldWebhookCutoverReceipt(receipt, expected = {}) {
  const identity = assertOriginalWebhookCutoverReceipt(receipt, expected)
  if (!["claimed", "writers-stopped"].includes(receipt.phase))
    fail("Webhook recovery requires the original held maintenance phase")
  return identity
}

function validateCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !/^[0-9]+$/.test(candidate.recoveryRunId ?? "") ||
    !Number.isSafeInteger(candidate.recoveryAttempt) ||
    candidate.recoveryAttempt < 1 ||
    !sha40.test(candidate.sourceRevision ?? "") ||
    !sha40.test(candidate.engineRevision ?? "") ||
    !imageDigest.test(candidate.workerImage ?? "") ||
    candidate.protocol !== "durable-claims/2"
  )
    fail("Invalid recovery worker candidate identity")
}

/**
 * Add provenance for a cross-run recovery image without changing the original
 * maintenance owner, source, stop value, or attempt history.
 */
export function appendWebhookRecoveryCandidate(receipt, candidate) {
  const { ownerRunId } = assertHeldWebhookCutoverReceipt(receipt)
  validateCandidate(candidate)
  if (candidate.recoveryRunId === ownerRunId)
    fail("A recovery invocation must have a different run id from the cutover owner")

  const existing = receipt.recoveryCandidates ?? []
  if (!Array.isArray(existing) || existing.length > recoveryLimit)
    fail("Invalid webhook recovery candidate history")
  for (const item of existing) validateCandidate(item)
  if (
    existing.some((item) => item.recoveryRunId === candidate.recoveryRunId) &&
    existing.at(-1)?.recoveryRunId !== candidate.recoveryRunId
  )
    fail("A superseded recovery invocation cannot be reactivated")
  for (let index = 0; index < existing.length; index += 1) {
    const previous = existing[index]
    if (previous.recoveryRunId === candidate.recoveryRunId) {
      if (previous.sourceRevision !== candidate.sourceRevision)
        fail("Recovery run source identity cannot be changed")
      if (index === existing.length - 1 && candidate.recoveryAttempt < previous.recoveryAttempt)
        fail("Recovery attempt history cannot move backwards")
    }
  }

  const sameAttempt = existing.find(
    (item) =>
      item.recoveryRunId === candidate.recoveryRunId &&
      item.recoveryAttempt === candidate.recoveryAttempt,
  )
  if (sameAttempt) {
    if (existing.at(-1) !== sameAttempt)
      fail("A superseded recovery candidate cannot be reactivated")
    if (
      sameAttempt.sourceRevision !== candidate.sourceRevision ||
      sameAttempt.engineRevision !== candidate.engineRevision ||
      sameAttempt.workerImage !== candidate.workerImage ||
      sameAttempt.protocol !== candidate.protocol
    )
      fail("Recovery attempt identity cannot be changed")
    return receipt
  }

  if (existing.length >= recoveryLimit) fail("Webhook recovery candidate history is full")

  return { ...receipt, recoveryCandidates: [...existing, candidate] }
}

export function assertRecordedWebhookCutoverCandidate(
  receipt,
  { workerImage, productRevision, engineRevision, protocol },
) {
  validateOriginalReceipt(receipt)
  if (protocol !== "durable-claims/2") fail("Cutover worker protocol is incompatible")

  const recoveryCandidates = receipt.recoveryCandidates ?? []
  if (!Array.isArray(recoveryCandidates) || recoveryCandidates.length > recoveryLimit)
    fail("Invalid webhook recovery candidate history")
  for (const candidate of recoveryCandidates) validateCandidate(candidate)

  const latest = recoveryCandidates.at(-1)
  const recoveryMatches = latest &&
    latest.workerImage === workerImage &&
    latest.sourceRevision === productRevision &&
    latest.engineRevision === engineRevision &&
    latest.protocol === protocol
      ? [latest]
      : []
  const originalMatches =
    receipt.candidateWorkerImage === workerImage &&
    receipt.candidateProductRevision === productRevision &&
    receipt.candidateEngineRevision === engineRevision &&
    receipt.candidateWebhookTrackClaimProtocol === protocol
  if (recoveryMatches.length + Number(originalMatches) !== 1)
    fail("Worker image is not uniquely recorded as a compatible cutover candidate")
  return true
}

export function assertWebhookRecoveryCandidate(receipt, expected) {
  const identity = assertHeldWebhookCutoverReceipt(receipt, {
    ownerRunId: expected.ownerRunId,
    ownerSourceSha: expected.ownerSourceSha,
    owner: expected.owner,
  })
  if (expected.recoveryRunId === identity.ownerRunId)
    fail("Webhook recovery must use a separate invocation identity")
  if (!Array.isArray(receipt.recoveryCandidates) || receipt.recoveryCandidates.length === 0)
    fail("No recovery worker candidate has been recorded")
  const latest = receipt.recoveryCandidates.at(-1)
  validateCandidate(latest)
  if (
    latest.recoveryRunId !== expected.recoveryRunId ||
    latest.recoveryAttempt !== expected.recoveryAttempt ||
    latest.sourceRevision !== expected.sourceRevision ||
    latest.engineRevision !== expected.engineRevision ||
    latest.workerImage !== expected.workerImage ||
    latest.protocol !== "durable-claims/2"
  )
    fail("Recorded recovery candidate does not match this invocation")
  return true
}

/** Verify a completed recovery archive for an idempotent completion retry. */
export function assertCompletedWebhookRecoveryReceipt(receipt, expected) {
  const identity = validateOriginalReceipt(receipt, { allowCompleted: true })
  if (
    receipt.phase !== "completed" ||
    identity.ownerRunId !== expected.ownerRunId ||
    identity.ownerSourceSha !== expected.ownerSourceSha ||
    receipt.owner !== expected.owner
  )
    fail("Completed webhook recovery owner identity mismatch")

  const candidates = receipt.recoveryCandidates ?? []
  const releases = receipt.recoveryReleases ?? []
  const candidate = Array.isArray(candidates) ? candidates.at(-1) : undefined
  const release = Array.isArray(releases) ? releases.at(-1) : undefined
  const matches = (item) =>
    item &&
    item.recoveryRunId === expected.recoveryRunId &&
    item.recoveryAttempt === expected.recoveryAttempt &&
    item.sourceRevision === expected.sourceRevision &&
    item.engineRevision === expected.engineRevision &&
    item.workerImage === expected.workerImage &&
    item.protocol === "durable-claims/2"
  if (
    !matches(candidate) ||
    !matches({
      ...release,
      recoveryRunId: release?.runId,
      recoveryAttempt: release?.attempt,
    }) ||
    release.status !== "released" ||
    !matches({
      ...receipt.recoveryCompleted,
      recoveryRunId: receipt.recoveryCompleted?.runId,
      recoveryAttempt: receipt.recoveryCompleted?.attempt,
    })
  )
    fail("Completed webhook recovery candidate or release identity mismatch")
  return true
}

/** Verify the actual digest-pinned worker against the last recorded recovery. */
export function assertWebhookCutoverWorkerIdentity({
  receipt,
  workerImage,
  productRevision,
  engineRevision,
  workerDigest,
  protocol,
  environment,
}) {
  validateOriginalReceipt(receipt, { allowCompleted: true })
  const candidates = receipt.recoveryCandidates ?? []
  if (!Array.isArray(candidates)) fail("Invalid webhook recovery candidate history")
  let expected
  if (candidates.length > 0) {
    if (candidates.length > recoveryLimit)
      fail("Invalid webhook recovery candidate history")
    for (const item of candidates) validateCandidate(item)
    expected = candidates.at(-1)
    if (
      expected.workerImage !== workerImage ||
      expected.sourceRevision !== productRevision ||
      expected.engineRevision !== engineRevision ||
      expected.protocol !== protocol
    )
      fail("Running worker does not match the recorded recovery candidate")
  } else {
    if (
      receipt.candidateWorkerImage !== workerImage ||
      receipt.candidateProductRevision !== receipt.productRevision ||
      receipt.productRevision !== productRevision ||
      receipt.candidateEngineRevision !== engineRevision ||
      receipt.candidateWebhookTrackClaimProtocol !== protocol
    )
      fail("Running worker does not match the original cutover candidate")
    expected = { workerImage }
  }

  const match = imageDigest.exec(expected.workerImage)
  if (!match || workerDigest !== `sha256:${match[1]}` || protocol !== "durable-claims/2")
    fail("Running worker digest or protocol does not match the cutover receipt")

  const hash = (value) => createHash("sha256").update(value ?? "").digest("hex")
  if (
    receipt.databaseUrlSha256 !== hash(environment.DATABASE_URL) ||
    receipt.databaseSystemUrlSha256 !== hash(environment.DATABASE_SYSTEM_URL) ||
    receipt.redisUrlSha256 !== hash(environment.REDIS_URL)
  )
    fail("Cutover worker database or Redis identity changed")

  return true
}
