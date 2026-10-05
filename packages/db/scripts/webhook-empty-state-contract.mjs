import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import parsePgConnectionString from "pg-connection-string"

const PROJECT_REF = /^[a-z0-9]{20}$/
const SHA256 = /^[a-f0-9]{64}$/
const SOURCE_SHA = /^[a-f0-9]{40}$/
const URL_QUERY_ALLOWLIST = new Set(["schema", "sslmode"])
const SAFE_SSL_MODES = new Set(["require", "verify-full"])

export function parsePostgresConnectionTarget(raw, label = "database URL") {
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
  if (url.hash) throw new Error(`${label} must not contain a URL fragment`)

  // node-postgres 8.23.0 uses pg-connection-string 2.14.0, whose parser
  // promotes query keys such as host/user/port/password to connection fields.
  // Prisma and node-postgres do not share the same URL parser. Keep only the
  // two non-identity options this migration supports, reject duplicate keys,
  // and compare the effective node-postgres target with the URI authority.
  const seen = new Set()
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) throw new Error(`${label} contains a duplicate query parameter`)
    seen.add(key)
    if (!URL_QUERY_ALLOWLIST.has(key)) {
      throw new Error(`${label} contains an unsupported or unsafe query parameter`)
    }
  }
  const sslmode = url.searchParams.get("sslmode")
  if (sslmode !== null && !SAFE_SSL_MODES.has(sslmode)) {
    throw new Error(`${label} sslmode must require verified TLS`)
  }

  let user
  let password
  let database
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
    database = decodeURI(url.pathname.slice(1))
  } catch {
    throw new Error(`${label} contains invalid percent-encoding`)
  }
  if (!user || !database) throw new Error(`${label} must include a username and database`)
  const schema = url.searchParams.get("schema") || "public"

  let effective
  try {
    effective = parsePgConnectionString(raw)
  } catch {
    throw new Error(`${label} cannot be parsed by node-postgres`)
  }
  const targetPort = url.port || ""
  if (
    effective.host !== url.hostname || effective.port !== targetPort ||
    effective.user !== user || effective.password !== password || effective.database !== database
  ) {
    throw new Error(`${label} has different effective node-postgres and Prisma targets`)
  }
  return { url, host: url.hostname, user, database, schema, port: targetPort || "5432" }
}

export function assertDisposablePostgresUrl(raw, label = "disposable PostgreSQL URL") {
  const target = parsePostgresConnectionTarget(raw, label)
  if (!["localhost", "127.0.0.1", "::1"].includes(target.host) ||
      target.port !== "5432" || target.database !== "postgres" || target.schema !== "public") {
    throw new Error(`${label} must target loopback PostgreSQL postgres/public on port 5432`)
  }
  return target
}

export function createDisposablePostgresClient(raw, ClientClass, options = {}) {
  assertDisposablePostgresUrl(raw)
  if (typeof ClientClass !== "function") throw new Error("A PostgreSQL client constructor is required")
  return new ClientClass({ ...options, connectionString: raw })
}

function hasOuterParentheses(expression) {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return false
  let depth = 0
  let quote = null
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (quote) {
      if (char === quote) {
        if (expression[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0 && index !== expression.length - 1) return false
    }
  }
  return depth === 0 && quote === null
}

export function normalizeDefault(value) {
  if (value === null || value === undefined) return null
  let expression = String(value).trim()
  while (hasOuterParentheses(expression)) expression = expression.slice(1, -1).trim()
  let normalized = ""
  let quote = null
  let pendingSpace = false
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (quote) {
      normalized += char
      if (char === quote) {
        if (expression[index + 1] === quote) normalized += expression[++index]
        else quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      if (pendingSpace && normalized) normalized += " "
      pendingSpace = false
      quote = char
      normalized += char
    } else if (/\s/.test(char)) pendingSpace = true
    else {
      if (pendingSpace && normalized) normalized += " "
      pendingSpace = false
      normalized += char.toUpperCase()
    }
  }
  return normalized
}

function parseDatabaseUrl(raw, label) {
  const parsed = parsePostgresConnectionTarget(raw, label)
  const { url, user, database, schema, port } = parsed
  if (!database || database !== "postgres" || schema !== "public") {
    throw new Error(`${label} must target postgres/public`)
  }

  const direct = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i)
  if (direct) {
    if (user !== "postgres" || (port && port !== "5432")) {
      throw new Error(`${label} direct Supabase URL must use postgres on port 5432`)
    }
    return { projectRef: direct[1].toLowerCase(), database, schema, kind: "direct", port: port || "5432" }
  }

  if (/\.pooler\.supabase\.com$/i.test(url.hostname)) {
    const pooler = user.match(/^postgres\.([a-z0-9]{20})$/i)
    if (!pooler) throw new Error(`${label} pooler username must bind the Supabase project ref`)
    if (port && !new Set(["5432", "6543"]).has(port)) throw new Error(`${label} uses an unsupported Supavisor port`)
    return { projectRef: pooler[1].toLowerCase(), database, schema, kind: "pooler", port: port || "5432" }
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

export function verifySignedEmptyStateReceipt(receipt, publicKeyPem) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Empty-state maintenance receipt is required")
  }
  if (typeof publicKeyPem !== "string" || publicKeyPem.length < 80 || publicKeyPem.length > 4096) {
    throw new Error("Trusted empty-state receipt public key is required")
  }
  const keys = Object.keys(receipt)
  const signature = receipt.signature
  if (keys.at(-1) !== "signature" || typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw new Error("Empty-state receipt signature is missing or malformed")
  }
  const unsigned = { ...receipt }
  delete unsigned.signature
  try {
    const key = createPublicKey(publicKeyPem)
    const signatureBytes = Buffer.from(signature, "base64")
    if (signatureBytes.length !== 64 || !verifySignature(null, Buffer.from(JSON.stringify(unsigned)), key, signatureBytes)) {
      throw new Error("invalid signature")
    }
  } catch {
    throw new Error("Empty-state receipt signature is not trusted")
  }
  return true
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
  const logicalIdentityFields = [
    "databaseIdentitySha256",
    "migrationDatabaseIdentitySha256",
    "appDatabaseIdentitySha256",
    "workerDatabaseUrlIdentitySha256",
    "workerDatabaseSystemUrlIdentitySha256",
  ]
  for (const field of logicalIdentityFields) {
    if (!SHA256.test(receipt[field] || "") || receipt[field] !== expected.databaseIdentitySha256) {
      throw new Error("Maintenance receipt database identity does not match: " + field)
    }
  }
  for (const field of ["rootReceiptSha256", "workerStopReceiptSha256", "admissionStopValueSha256"]) {
    if (!SHA256.test(receipt[field] || "")) throw new Error(`Maintenance receipt ${field} is invalid`)
  }
  for (const field of ["redisIdentitySha256", "queueSnapshotSha256", "fallbackEvidenceSha256"]) {
    if (!SHA256.test(receipt[field] || "")) throw new Error("Maintenance receipt " + field + " is invalid")
  }
  for (const field of ["workerStopImageDigest", "fallbackWorkerImageDigest"]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(receipt[field] || "")) throw new Error("Maintenance receipt " + field + " is invalid")
  }
  if (!SOURCE_SHA.test(receipt.workerStopSourceSha || "") || !SOURCE_SHA.test(receipt.fallbackSourceSha || "")) {
    throw new Error("Maintenance receipt worker image source is invalid")
  }
  if (!/^[a-f0-9]{40}$/.test(receipt.fallbackEngineRevision || "") || receipt.fallbackProtocol !== "durable-claims/2") {
    throw new Error("Maintenance receipt fallback protocol is not verified")
  }
  const issued = Date.parse(receipt.issuedAt)
  const now = expected.now ?? Date.now()
  if (!Number.isFinite(issued) || issued > now + 5 * 60_000 || now - issued > 30 * 60_000) {
    throw new Error("Maintenance receipt is outside its 30-minute validity window")
  }
  if (receipt.nonterminalScans !== 0 || receipt.pendingQueueJobs !== 0 ||
      receipt.activeWriterRevisions !== 0 || receipt.inFlightHandlers !== 0) {
    throw new Error("Maintenance receipt does not prove drained work")
  }
  const queueStates = ["wait", "active", "delayed", "prioritized", "waiting-children", "paused"]
  const queueNames = ["scan", "webhookTrackRetry", "fixGenerate"]
  if (!receipt.queueCounts || typeof receipt.queueCounts !== "object" || Array.isArray(receipt.queueCounts)) {
    throw new Error("Maintenance receipt queue snapshot is missing")
  }
  if (Object.keys(receipt.queueCounts).sort().join(",") !== queueNames.slice().sort().join(",")) {
    throw new Error("Maintenance receipt does not cover every required queue")
  }
  for (const queueName of queueNames) {
    const counts = receipt.queueCounts[queueName]
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      throw new Error("Maintenance receipt queue snapshot is malformed: " + queueName)
    }
    for (const state of queueStates) {
      if (counts[state] !== 0) throw new Error("Maintenance receipt has non-empty queue state: " + queueName + "/" + state)
    }
  }
  if (receipt.queueSchedulerCount !== 0 || receipt.repeatableJobCount !== 0) {
    throw new Error("Maintenance receipt contains active queue schedulers")
  }
  if (receipt.writersStopped !== true || receipt.admissionHeld !== true ||
      receipt.fallbackVerified !== true || receipt.redisContinuityVerified !== true ||
      receipt.appConnectionReadbackVerified !== true) {
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
    migrationDatabaseIdentitySha256: receipt.migrationDatabaseIdentitySha256,
    appDatabaseIdentitySha256: receipt.appDatabaseIdentitySha256,
    workerDatabaseUrlIdentitySha256: receipt.workerDatabaseUrlIdentitySha256,
    workerDatabaseSystemUrlIdentitySha256: receipt.workerDatabaseSystemUrlIdentitySha256,
    redisIdentitySha256: receipt.redisIdentitySha256,
    queueSnapshotSha256: receipt.queueSnapshotSha256,
    queueCounts: receipt.queueCounts,
    queueSchedulerCount: receipt.queueSchedulerCount,
    repeatableJobCount: receipt.repeatableJobCount,
    workerStopImageDigest: receipt.workerStopImageDigest,
    workerStopSourceSha: receipt.workerStopSourceSha,
    fallbackWorkerImageDigest: receipt.fallbackWorkerImageDigest,
    fallbackSourceSha: receipt.fallbackSourceSha,
    fallbackEngineRevision: receipt.fallbackEngineRevision,
    fallbackProtocol: receipt.fallbackProtocol,
    fallbackEvidenceSha256: receipt.fallbackEvidenceSha256,
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
