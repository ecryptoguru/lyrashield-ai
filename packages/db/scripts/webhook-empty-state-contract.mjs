import { createHash } from "node:crypto"

const PROJECT_REF = /^[a-z0-9]{20}$/
const SHA256 = /^[a-f0-9]{64}$/
const SOURCE_SHA = /^[a-f0-9]{40}$/

function parseDatabaseUrl(raw, label) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 8192) {
    throw new Error(`${label} is missing or invalid`)
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} is not a valid PostgreSQL URL`)
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error(`${label} must use PostgreSQL`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  const schema = url.searchParams.get("schema") || "public"
  if (!database || database !== "postgres" || schema !== "public") {
    throw new Error(`${label} must target postgres/public`)
  }

  const direct = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)
  if (direct) return { projectRef: direct[1].toLowerCase(), database, schema, kind: "direct" }

  if (/\.pooler\.supabase\.com$/i.test(url.hostname)) {
    const username = decodeURIComponent(url.username)
    const pooler = username.match(/^postgres\.([a-z0-9]{20})$/i)
    if (!pooler) throw new Error(`${label} pooler username must bind the Supabase project ref`)
    return { projectRef: pooler[1].toLowerCase(), database, schema, kind: "pooler" }
  }
  throw new Error(`${label} host is not a recognized Supabase direct or pooler endpoint`)
}

export function canonicalSupabaseDatabaseIdentity(urls) {
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    throw new Error("At least one database URL is required")
  }
  const parsed = urls.map((entry, index) => parseDatabaseUrl(entry, `database URL ${index + 1}`))
  const projectRef = parsed[0].projectRef
  if (parsed.some((entry) => entry.projectRef !== projectRef)) {
    throw new Error("Database URLs resolve to different Supabase projects")
  }
  if (parsed.some((entry) => entry.database !== parsed[0].database || entry.schema !== parsed[0].schema)) {
    throw new Error("Database URLs resolve to different logical databases")
  }
  return Object.freeze({
    provider: "supabase",
    projectRef,
    database: parsed[0].database,
    schema: parsed[0].schema,
  })
}

export function hashDatabaseIdentity(identity) {
  const canonical = {
    provider: identity?.provider,
    projectRef: identity?.projectRef,
    database: identity?.database,
    schema: identity?.schema,
  }
  if (
    canonical.provider !== "supabase" ||
    !PROJECT_REF.test(canonical.projectRef || "") ||
    canonical.database !== "postgres" ||
    canonical.schema !== "public"
  ) {
    throw new Error("Database identity is not canonical")
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export function validateEmptyStateAuthorization(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Empty-state maintenance receipt is required")
  }
  if (receipt.schemaVersion !== "webhook-empty-state-maintenance/v1" || receipt.mode !== "empty-state") {
    throw new Error("Maintenance receipt does not authorize empty-state mode")
  }
  if (!SOURCE_SHA.test(receipt.sourceSha || "") || receipt.sourceSha !== expected.sourceSha) {
    throw new Error("Maintenance receipt source does not match this deployment")
  }
  if (receipt.runId !== expected.runId || !/^\d+$/.test(receipt.runId || "")) {
    throw new Error("Maintenance receipt run ID does not match")
  }
  if (!new RegExp(`^${receipt.runId}:[1-9][0-9]*$`).test(receipt.owner || "")) {
    throw new Error("Maintenance receipt owner is invalid")
  }
  const ownerAttempt = Number(receipt.owner.split(":")[1])
  const currentAttempt = Number(expected.runAttempt || 1)
  if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 1 || ownerAttempt > currentAttempt) {
    throw new Error("Maintenance receipt owner belongs to a later workflow attempt")
  }
  if (receipt.stableNonce !== expected.stableNonce || !/^[A-Za-z0-9_-]{32,128}$/.test(receipt.stableNonce || "")) {
    throw new Error("Maintenance receipt stable nonce does not match")
  }
  if (receipt.databaseIdentitySha256 !== expected.databaseIdentitySha256 || !SHA256.test(receipt.databaseIdentitySha256 || "")) {
    throw new Error("Maintenance receipt database identity does not match")
  }
  for (const field of ["rootReceiptSha256", "workerStopReceiptSha256", "admissionStopValueSha256"]) {
    if (!SHA256.test(receipt[field] || "")) throw new Error(`Maintenance receipt ${field} is invalid`)
  }
  const issued = Date.parse(receipt.issuedAt)
  const now = expected.now ?? Date.now()
  if (!Number.isFinite(issued) || issued > now + 5 * 60_000 || now - issued > 30 * 60_000) {
    throw new Error("Maintenance receipt is outside its 30-minute validity window")
  }
  if (receipt.nonterminalScans !== 0 || receipt.pendingQueueJobs !== 0) {
    throw new Error("Maintenance receipt does not prove drained work")
  }
  if (receipt.writersStopped !== true || receipt.admissionHeld !== true || receipt.fallbackVerified !== true) {
    throw new Error("Maintenance receipt does not prove all writer and fallback gates")
  }
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    mode: receipt.mode,
    sourceSha: receipt.sourceSha,
    runId: receipt.runId,
    owner: receipt.owner,
    stableNonce: receipt.stableNonce,
    databaseIdentitySha256: receipt.databaseIdentitySha256,
    rootReceiptSha256: receipt.rootReceiptSha256,
    workerStopReceiptSha256: receipt.workerStopReceiptSha256,
    admissionStopValueSha256: receipt.admissionStopValueSha256,
    issuedAt: new Date(issued).toISOString(),
  })
}

export function assertMigrationUrlBinding(env) {
  const direct = env?.DATABASE_DIRECT_URL
  const ordinary = env?.DATABASE_URL
  if (typeof direct !== "string" || direct.length === 0 || direct !== ordinary) {
    throw new Error("DATABASE_DIRECT_URL and DATABASE_URL must be the same validated migration URL")
  }
  return direct
}

export const EXPECTED_EMPTY_MIGRATIONS = Object.freeze([
  { name: "20261002120000_webhook_track_due_db_default", sha256: "0b84609011c35ee62dd671dbf47c947156f6fc624718a98373fe6ee7ef91693f" },
  { name: "20261002130000_webhook_track_utc_schedule", sha256: "3cf195cc44af5abf48b55e93ec057142c4ca1079a2664c8602369fe816a78d97" },
  { name: "20261002130100_webhook_track_utc_schedule_index", sha256: "ebfa8c71735d3b13eafd7c9f1514f1f5e3672f42bf4fefc9710147375ae92439" },
  { name: "20261002130200_webhook_track_operator_recovery", sha256: "72cbfad72bc74f1a0201e240c26e82e735b30fceaaf675fec9b8d53af0b63d63" },
])
