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

/**
 * Prevent Vitest from inheriting developer credentials by default. Database
 * suites run only when the caller explicitly opts into named loopback fixtures.
 */
export function configureVitestDatabaseEnvironment(env) {
  // Rate limiting's HTTPS credentials are not a local Redis service. Never
  // let unit or disposable-service suites reach an external Upstash account.
  for (const key of REMOTE_REDIS_ENV_KEYS) delete env[key]

  if (env.LYRASHIELD_TEST_DB_DISPOSABLE !== "1") {
    for (const key of [...DATABASE_ENV_KEYS, ...REDIS_ENV_KEYS]) delete env[key]
    for (const key of DATABASE_OPT_IN_KEYS) delete env[key]
    // The application env schema requires DATABASE_URL at import time. This
    // dead local endpoint satisfies parsing without exposing developer DB data.
    env.DATABASE_URL = UNIT_DATABASE_URL
    return false
  }

  const databaseUrls = DATABASE_ENV_KEYS.flatMap((key) => (env[key] ? [[key, env[key]]] : []))
  if (databaseUrls.length === 0 || !env.DATABASE_URL) {
    throw new Error("Disposable-service tests require an explicit DATABASE_URL")
  }

  for (const [key, value] of databaseUrls) {
    const url = assertLoopbackUrl(key, value, new Set(["postgres:", "postgresql:"]))
    if (!isDisposableDatabase(databaseName(url))) {
      throw new Error(`${key} must point to a named test database`)
    }
  }

  for (const key of REDIS_ENV_KEYS) {
    if (env[key]) assertLoopbackUrl(key, env[key], new Set(["redis:", "rediss:"]))
  }

  return true
}
