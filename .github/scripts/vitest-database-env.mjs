const DATABASE_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_DIRECT_URL",
  "DATABASE_SYSTEM_URL",
  "DATABASE_SYSTEM_DIRECT_URL",
  "RLS_RUNTIME_DATABASE_URL",
  "RLS_SYSTEM_DATABASE_URL",
  "SHADOW_DATABASE_URL",
  "TEST_DATABASE_URL",
]

const REDIS_ENV_KEYS = ["REDIS_URL", "TEST_REDIS_URL", "BULLMQ_TEST_REDIS_URL"]
const REMOTE_REDIS_ENV_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]
const DATABASE_OPT_IN_KEYS = [
  "ACCOUNT_PREFERENCE_RLS_RUNTIME_TEST",
  "AGENT_OPERATION_WORKSPACE_DB_TEST",
  "BILLING_METER_POSTGRES_TEST",
  "BULLMQ_PRODUCER_REDIS_TEST",
  "GROWTH_METRICS_DB_TEST",
  "TEAM_MUTATION_DB_TEST",
  "TRIAL_INTEGRATION_TEST",
  "WEBHOOK_TRACK_POSTGRES_REDIS_TEST",
]
const UNIT_DATABASE_URL = "postgresql://vitest:vitest@127.0.0.1:1/lyrashield_test"
const POSTGRES_OVERRIDE_ENV_KEYS = [
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSYSCONFDIR",
  "PGOPTIONS",
]

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const DISPOSABLE_DATABASES = new Set([
  "lyrashield",
  "lyrashield_shadow",
  "v15_product",
  "lyra_v18_ci",
  "v22_agent_fk_ci",
])

function databaseName(url) {
  return decodeURIComponent(url.pathname.replace(/^\//, ""))
}

function assertLoopbackUrl(name, value, protocols) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid disposable-service URL`)
  }
  if (!protocols.has(url.protocol)) {
    throw new Error(`${name} must use a local disposable-service protocol`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must use a loopback host for disposable-service tests`)
  }
  return url
}

function isDisposableDatabase(name) {
  return DISPOSABLE_DATABASES.has(name) || /(?:^|[_-])(?:test|ci|disposable)(?:$|[_-])/i.test(name)
}

function assertDisposableDatabaseUrl(name, value) {
  const url = assertLoopbackUrl(name, value, new Set(["postgres:", "postgresql:"]))
  try {
    if (!decodeURIComponent(url.username) || !decodeURIComponent(url.password)) {
      throw new Error("missing credentials")
    }
  } catch {
    throw new Error(`${name} must include explicit fixture credentials`)
  }
  // pg-connection-string promotes query values into its connection config.
  // Check decoded keys before any driver parser can override the authority,
  // credentials or database, or load certificate files. Only the schema option
  // used by our Prisma fixtures is supported; aliases and duplicates fail closed.
  const seen = new Set()
  for (const key of url.searchParams.keys()) {
    if (key !== "schema" || seen.has(key)) {
      throw new Error(`${name} contains an unsupported or duplicate query parameter`)
    }
    seen.add(key)
  }
  let database
  try {
    database = databaseName(url)
  } catch {
    throw new Error(`${name} must point to a named test database`)
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(database) || !isDisposableDatabase(database)) {
    throw new Error(`${name} must point to a named test database`)
  }
  // Ambient PGPORT is rejected separately, so an omitted port uses pg's default.
  const port = url.port || "5432"
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${name} must use a valid disposable-service port`)
  }
  return { host: url.hostname, port: String(Number(port)), database }
}

function assertNoPostgresEnvironmentOverrides(env) {
  for (const key of POSTGRES_OVERRIDE_ENV_KEYS) {
    if (env[key]) throw new Error(`${key} must be unset for disposable-service tests`)
  }
}

/** Assert the exact owner/runtime fixture pair before constructing either client. */
export function assertDisposableDatabasePair(env) {
  if (env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
    throw new Error("Disposable database fixtures require explicit disposable-service opt-in")
  }
  if (!env.DATABASE_URL || !env.RLS_RUNTIME_DATABASE_URL) {
    throw new Error(
      "Disposable database fixtures require DATABASE_URL and RLS_RUNTIME_DATABASE_URL"
    )
  }
  assertNoPostgresEnvironmentOverrides(env)
  const owner = assertDisposableDatabaseUrl("DATABASE_URL", env.DATABASE_URL)
  const runtime = assertDisposableDatabaseUrl(
    "RLS_RUNTIME_DATABASE_URL",
    env.RLS_RUNTIME_DATABASE_URL
  )
  // Do not resolve or conflate localhost/IPv4/IPv6 aliases: they may identify
  // different listeners. Equivalent explicit/default PostgreSQL ports match.
  if (
    owner.host !== runtime.host ||
    owner.port !== runtime.port ||
    owner.database !== runtime.database
  ) {
    throw new Error(
      "DATABASE_URL and RLS_RUNTIME_DATABASE_URL must name the same local test database"
    )
  }
}

/**
 * Prevent Vitest from inheriting developer credentials by default. Database
 * suites run only when the caller explicitly opts into named loopback fixtures.
 */
export function configureVitestDatabaseEnvironment(env) {
  // Rate limiting's HTTPS credentials are not a local Redis service. Never
  // let unit or disposable-service suites reach an external Upstash account.
  for (const key of REMOTE_REDIS_ENV_KEYS) delete env[key]

  if (env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
    for (const key of [...DATABASE_ENV_KEYS, ...REDIS_ENV_KEYS, ...POSTGRES_OVERRIDE_ENV_KEYS])
      delete env[key]
    for (const key of DATABASE_OPT_IN_KEYS) delete env[key]
    // The application env schema requires DATABASE_URL at import time. This
    // dead local endpoint satisfies parsing without exposing developer DB data.
    env.DATABASE_URL = UNIT_DATABASE_URL
    return false
  }

  assertNoPostgresEnvironmentOverrides(env)

  const databaseUrls = DATABASE_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : []))
  if (databaseUrls.length === 0 || !env.DATABASE_URL) {
    throw new Error("Disposable-service tests require an explicit DATABASE_URL")
  }

  for (const [key, value] of databaseUrls) {
    assertDisposableDatabaseUrl(key, value)
  }

  for (const key of REDIS_ENV_KEYS) {
    if (env[key]) assertLoopbackUrl(key, env[key], new Set(["redis:", "rediss:"]))
  }

  return true
}
