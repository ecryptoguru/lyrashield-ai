import { createHash } from "node:crypto"

export const REPOSITORY = "ecryptoguru/lyrashield-ai"
export const REPOSITORY_ID = "1286618458"
export const OWNER_ID = "116722580"
export const WORKFLOW = ".github/workflows/webhook-empty-state-trusted-attestation.yml"
export const CALLER = ".github/workflows/webhook-empty-state-cutover.yml"
export const PREDICATE = "https://lyrashieldai.com/attestations/webhook-empty-state/v2"
export const QUEUES = ["scan", "webhookTrackRetry", "fixGenerate"]
export const STATES = ["wait", "active", "delayed", "prioritized", "waiting-children", "paused"]
export const sha256 = (value) => createHash("sha256").update(value).digest("hex")
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("Non-canonical receipt value")
  return JSON.stringify(value)
}
export function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
export function exactKeys(value, keys, label) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    `${label} fields are incomplete or unexpected`
  )
}
const hash = (value, label) =>
  requireValue(/^[a-f0-9]{64}$/.test(value || ""), `${label} digest invalid`)
const source = (value) => /^[a-f0-9]{40}$/.test(value || "")
const digest = (value) => /^sha256:[a-f0-9]{64}$/.test(value || "")
export function validateAuthorization(authorization, policy, now = Date.now()) {
  exactKeys(
    authorization,
    [
      "sourceSha",
      "runId",
      "originalAttempt",
      "owner",
      "nonce",
      "issuedAt",
      "expiresAt",
      "policySha256",
      "producerSha256",
      "workflowSha",
      "repositoryId",
      "ownerId",
    ],
    "Authorization"
  )
  requireValue(
    policy.enabled === true && policy.revoked === false,
    "Root policy disabled or revoked"
  )
  requireValue(
    authorization.repositoryId === REPOSITORY_ID && authorization.ownerId === OWNER_ID,
    "Wrong repository identity"
  )
  requireValue(
    source(authorization.sourceSha) && authorization.sourceSha === policy.sourceSha,
    "Wrong source"
  )
  requireValue(
    /^[1-9][0-9]{0,19}$/.test(authorization.runId) && authorization.runId === policy.runId,
    "Wrong run"
  )
  requireValue(
    Number.isSafeInteger(authorization.originalAttempt) &&
      authorization.originalAttempt >= 1 &&
      authorization.originalAttempt === policy.originalAttempt &&
      authorization.owner === `${authorization.runId}:${authorization.originalAttempt}`,
    "Wrong original owner"
  )
  requireValue(
    /^[A-Za-z0-9_-]{32,128}$/.test(authorization.nonce || "") &&
      authorization.nonce === policy.nonce,
    "Wrong nonce"
  )
  for (const field of ["policySha256", "producerSha256"]) {
    hash(authorization[field], field)
    requireValue(authorization[field] === policy[field], `Wrong ${field}`)
  }
  requireValue(
    source(authorization.workflowSha) && authorization.workflowSha === policy.workflowSha,
    "Wrong trusted workflow SHA"
  )
  const issued = Date.parse(authorization.issuedAt),
    expires = Date.parse(authorization.expiresAt)
  requireValue(
    Number.isFinite(issued) &&
      Number.isFinite(expires) &&
      issued <= now &&
      expires > now &&
      expires - issued > 0 &&
      expires - issued <= 30 * 60_000 &&
      issued === Date.parse(policy.issuedAt) &&
      expires === Date.parse(policy.expiresAt),
    "Expired or expanded authorization window"
  )
  return sha256(canonical(authorization))
}
export function validateReceipt(receipt, policy, now = Date.now()) {
  exactKeys(receipt, ["schemaVersion", "mode", "authorization", "evidence"], "Receipt")
  requireValue(
    receipt.schemaVersion === "webhook-empty-state/v2" && receipt.mode === "empty-scheduling",
    "Wrong receipt mode"
  )
  const authorizationSha256 = validateAuthorization(receipt.authorization, policy, now)
  for (const field of ["databaseIdentitySha256", "redisIdentitySha256", "admissionValueSha256"])
    hash(policy[field], "Root " + field)
  const evidence = receipt.evidence
  exactKeys(
    evidence,
    [
      "observedAt",
      "database",
      "redis",
      "writers",
      "worker",
      "queues",
      "nonterminalScans",
      "inFlightHandlers",
      "trackRows",
      "unresolvedParents",
      "unknownWriters",
      "candidate",
      "fallback",
      "backup",
      "restore",
    ],
    "Evidence"
  )
  const observed = Date.parse(evidence.observedAt)
  requireValue(
    Number.isFinite(observed) &&
      observed >= Date.parse(receipt.authorization.issuedAt) &&
      observed <= now &&
      now - observed <= 30 * 60_000,
    "Stale observations"
  )
  exactKeys(
    evidence.database,
    ["app", "scanner", "worker", "system", "migration", "backup"],
    "Database observations"
  )
  for (const [name, connection] of Object.entries(evidence.database)) {
    exactKeys(
      connection,
      ["identitySha256", "credentialSha256", "resourceId", "observedAt"],
      `${name} connection`
    )
    hash(connection.identitySha256, name + " logical identity")
    hash(connection.credentialSha256, name)
    hash(policy.credentials?.[name], name + " approved credential")
    requireValue(
      typeof connection.resourceId === "string" && connection.resourceId.length > 0,
      "Missing actual connection resource"
    )
    requireValue(
      connection.identitySha256 === policy.databaseIdentitySha256 &&
        connection.resourceId === policy.resources[name] &&
        Date.parse(connection.observedAt) >= Date.parse(receipt.authorization.issuedAt) &&
        Date.parse(connection.observedAt) <= observed &&
        connection.credentialSha256 === policy.credentials[name],
      `Missing or changed ${name} database identity`
    )
  }
  exactKeys(
    evidence.redis,
    ["identitySha256", "credentialSha256", "owner", "valueSha256"],
    "Redis observation"
  )
  for (const field of ["identitySha256", "credentialSha256", "valueSha256"])
    hash(evidence.redis[field], "Redis " + field)
  hash(policy.credentials?.redis, "Approved Redis credential")
  requireValue(
    evidence.redis.identitySha256 === policy.redisIdentitySha256 &&
      evidence.redis.credentialSha256 === policy.credentials.redis &&
      evidence.redis.owner === receipt.authorization.owner &&
      evidence.redis.valueSha256 === policy.admissionValueSha256,
    "Foreign admission or Redis continuity failure"
  )
  requireValue(
    Array.isArray(evidence.writers) && evidence.writers.length === 2,
    "All writer resources must be observed"
  )
  for (const name of ["app", "scanner"]) {
    const writer = evidence.writers.find((value) => value.resourceId === policy.resources[name])
    requireValue(
      writer && Array.isArray(writer.revisions) && writer.revisions.length > 0,
      "Missing writer revision inventory"
    )
    for (const revision of writer.revisions) {
      exactKeys(revision, ["name", "active", "replicas"], "Writer revision")
      requireValue(
        typeof revision.name === "string" &&
          revision.name.length > 0 &&
          revision.active === false &&
          revision.replicas === 0,
        "Active writer, including zero-traffic revision"
      )
    }
  }
  exactKeys(
    evidence.worker,
    [
      "imageDigest",
      "sourceSha",
      "engineRevision",
      "serviceState",
      "timerState",
      "containers",
      "stopOwner",
      "stopAt",
      "stopProofSha256",
      "startupFenced",
    ],
    "Worker observation"
  )
  const worker = evidence.worker
  requireValue(
    digest(worker.imageDigest) &&
      source(worker.sourceSha) &&
      source(worker.engineRevision) &&
      worker.serviceState === "inactive" &&
      worker.timerState === "inactive" &&
      worker.containers === 0 &&
      worker.startupFenced === true &&
      worker.stopOwner === receipt.authorization.owner &&
      Date.parse(worker.stopAt) === observed,
    "Worker lacks fresh stop proof or startup fence"
  )
  hash(worker.stopProofSha256, "Worker stop")
  exactKeys(evidence.queues, QUEUES, "Queues")
  for (const name of QUEUES) {
    exactKeys(evidence.queues[name], ["counts", "schedulers", "repeats"], `${name} queue`)
    exactKeys(evidence.queues[name].counts, STATES, `${name} queue states`)
    requireValue(
      [
        ...Object.values(evidence.queues[name].counts),
        evidence.queues[name].schedulers,
        evidence.queues[name].repeats,
      ].every((value) => value === 0),
      "Latent queued or scheduled work"
    )
  }
  requireValue(
    [
      evidence.nonterminalScans,
      evidence.inFlightHandlers,
      evidence.trackRows,
      evidence.unresolvedParents,
      evidence.unknownWriters,
    ].every((value) => value === 0),
    "Scheduling or unresolved parent state is nonempty"
  )
  for (const name of ["candidate", "fallback"]) {
    exactKeys(
      evidence[name],
      [
        "imageDigest",
        "sourceSha",
        "engineRevision",
        "protocol",
        "rehearsalRunId",
        "rehearsalSha256",
      ],
      name
    )
    requireValue(
      digest(evidence[name].imageDigest) &&
        source(evidence[name].sourceSha) &&
        source(evidence[name].engineRevision) &&
        evidence[name].protocol === "durable-claims/2" &&
        /^[1-9][0-9]*$/.test(evidence[name].rehearsalRunId || "") &&
        canonical(evidence[name]) === canonical(policy[name]),
      `Wrong ${name} or missing exact image rehearsal`
    )
    hash(evidence[name].rehearsalSha256, name)
  }
  exactKeys(
    evidence.backup,
    [
      "objectIdSha256",
      "versionId",
      "encryptedSha256",
      "dumpSha256",
      "databaseIdentitySha256",
      "createdAt",
      "runId",
    ],
    "Backup"
  )
  for (const field of ["objectIdSha256", "encryptedSha256", "dumpSha256"])
    hash(evidence.backup[field], field)
  requireValue(
    evidence.backup.versionId &&
      evidence.backup.databaseIdentitySha256 === policy.databaseIdentitySha256 &&
      canonical(evidence.backup) === canonical(policy.backup),
    "Different backup object or target"
  )
  exactKeys(
    evidence.restore,
    ["backupSha256", "runId", "completedAt", "schemaSha256", "auditSha256", "readinessSha256"],
    "Restore"
  )
  requireValue(
    evidence.restore.backupSha256 === sha256(canonical(evidence.backup)) &&
      canonical(evidence.restore) === canonical(policy.restore) &&
      Date.parse(evidence.restore.completedAt) >= Date.parse(evidence.backup.createdAt) &&
      Date.parse(evidence.restore.completedAt) <= now,
    "Restore did not prove the exact produced object"
  )
  for (const field of ["schemaSha256", "auditSha256", "readinessSha256"])
    hash(evidence.restore[field], field)
  return { authorizationSha256, receiptSha256: sha256(canonical(receipt)) }
}
