import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import { configureVitestDatabaseEnvironment } from "../vitest-database-env.mjs"
import * as fixtureGuards from "../vitest-database-env.mjs"

const requireDb = createRequire(new URL("../../../packages/db/package.json", import.meta.url))
const { parse } = requireDb("pg-connection-string")
const ownerUrl = "postgresql://owner:fixture@127.0.0.1:5432/task4_disposable"
const runtimeUrl = "postgresql://runtime:fixture@127.0.0.1:5432/task4_disposable"
const fixtureEnv = (overrides = {}) => ({
  LYRASHIELD_TEST_DB_DISPOSABLE: "1",
  DATABASE_URL: ownerUrl,
  RLS_RUNTIME_DATABASE_URL: runtimeUrl,
  ...overrides,
})

describe("Vitest database environment", () => {
  it("removes database and Redis credentials from ordinary unit runs", () => {
    const env = {
      DATABASE_URL: "postgresql://user:pass@localhost:5432/lyrashield",
      RLS_RUNTIME_DATABASE_URL: "postgresql://runtime:pass@localhost:5432/lyrashield",
      REDIS_URL: "redis://localhost:6379",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "secret-token",
      TRIAL_INTEGRATION_TEST: "1",
    }

    assert.equal(configureVitestDatabaseEnvironment(env), false)
    assert.equal(env.DATABASE_URL, "postgresql://vitest:vitest@127.0.0.1:1/lyrashield_test")
    assert.equal(env.RLS_RUNTIME_DATABASE_URL, undefined)
    assert.equal(env.REDIS_URL, undefined)
    assert.equal(env.UPSTASH_REDIS_REST_URL, undefined)
    assert.equal(env.UPSTASH_REDIS_REST_TOKEN, undefined)
    assert.equal(env.TRIAL_INTEGRATION_TEST, undefined)
  })

  it("allows an explicitly declared local CI test database", () => {
    const env = {
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      DATABASE_URL: "postgresql://owner:pass@localhost:5432/lyrashield?schema=public",
      RLS_RUNTIME_DATABASE_URL:
        "postgresql://runtime:pass@127.0.0.1:5432/v15_product?schema=public",
      REDIS_URL: "redis://localhost:6379",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "secret-token",
    }

    assert.equal(configureVitestDatabaseEnvironment(env), true)
    assert.equal(
      env.DATABASE_URL,
      "postgresql://owner:pass@localhost:5432/lyrashield?schema=public"
    )
    assert.equal(env.UPSTASH_REDIS_REST_URL, undefined)
    assert.equal(env.UPSTASH_REDIS_REST_TOKEN, undefined)
  })

  it("rejects remote database credentials even when the disposable marker is set", () => {
    const env = {
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      DATABASE_URL: "postgresql://owner:pass@db.example.com:5432/lyrashield?schema=public",
    }

    assert.throws(() => configureVitestDatabaseEnvironment(env), /loopback/)
  })

  it("rejects a local database that is not named for test or CI use", () => {
    const env = {
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      DATABASE_URL: "postgresql://owner:pass@localhost:5432/production?schema=public",
    }

    assert.throws(() => configureVitestDatabaseEnvironment(env), /test database/)
  })

  it("validates every supplied database URL, including system access", () => {
    const env = {
      LYRASHIELD_TEST_DB_DISPOSABLE: "1",
      DATABASE_URL: "postgresql://owner:pass@localhost:5432/lyrashield?schema=public",
      DATABASE_SYSTEM_URL:
        "postgresql://owner:pass@remote.example.com:5432/lyrashield?schema=public",
    }

    assert.throws(() => configureVitestDatabaseEnvironment(env), /loopback/)
  })

  it("demonstrates installed pg routing and credential overrides without opening a connection", () => {
    const parsed = parse(`${ownerUrl}?host=remote.example&port=6543&user=other&password=override`)
    assert.equal(parsed.host, "remote.example")
    assert.equal(parsed.port, "6543")
    assert.equal(parsed.user, "other")
    assert.equal(parsed.password, "override")
  })

  it("checks installed pg environment fallback and explicit URL precedence without connecting", () => {
    const { Client } = requireDb("pg")
    const overrides = {
      PGHOST: "127.0.0.2",
      PGPORT: "6543",
      PGDATABASE: "ambient_disposable",
      PGUSER: "ambient-user",
      PGPASSWORD: "ambient-fixture",
      PGHOSTADDR: "remote.example",
      PGSERVICE: "ambient-service",
      PGSERVICEFILE: "/unused-fixture-service-file",
    }
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]])
    )
    try {
      Object.assign(process.env, overrides)
      const fallback = new Client({ connectionString: "postgresql://" }).connectionParameters
      assert.equal(fallback.host, overrides.PGHOST)
      assert.equal(fallback.port, 6543)
      assert.equal(fallback.database, overrides.PGDATABASE)
      assert.equal(fallback.user, overrides.PGUSER)
      assert.equal(fallback.password, overrides.PGPASSWORD)
      const explicit = new Client({ connectionString: ownerUrl }).connectionParameters
      assert.equal(explicit.host, "127.0.0.1")
      assert.equal(explicit.port, 5432)
      assert.equal(explicit.database, "task4_disposable")
      assert.equal(explicit.user, "owner")
      assert.equal(explicit.password, "fixture")
      // JS pg has no service/hostaddr resolution. Explicit fields prevail even
      // when those libpq variables exist; our fixture guard rejects them too.
      assert.equal(explicit.hostaddr, undefined)
      assert.equal(explicit.service, undefined)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  for (const key of [
    "host",
    "hostaddr",
    "port",
    "user",
    "username",
    "password",
    "passfile",
    "db",
    "dbname",
    "database",
    "connectionString",
    "service",
    "servicefile",
    "options",
    "sslcert",
    "sslkey",
    "sslrootcert",
  ]) {
    it(`rejects ${key} query aliases, encoded keys and duplicates before client construction`, () => {
      const encodedKey = `%${key.charCodeAt(0).toString(16)}${key.slice(1)}`
      for (const query of [
        `${key}=override`,
        `${key}=`,
        `${encodedKey}=override`,
        `${key}=safe&${key}=override`,
        `${encodedKey}=safe&${key}=override`,
        `${key.toUpperCase()}=override`,
        `%25${encodedKey.slice(1)}=override`,
      ]) {
        for (const envKey of [
          "DATABASE_URL",
          "RLS_RUNTIME_DATABASE_URL",
          "DATABASE_SYSTEM_URL",
          "SHADOW_DATABASE_URL",
        ]) {
          let constructed = false
          assert.throws(() => {
            configureVitestDatabaseEnvironment(fixtureEnv({ [envKey]: `${ownerUrl}?${query}` }))
            constructed = true
          }, /query parameter/)
          assert.equal(constructed, false)
        }
      }
    })
  }

  it("preserves the used schema option and rejects duplicate or unknown query options", () => {
    assert.equal(
      configureVitestDatabaseEnvironment(fixtureEnv({ DATABASE_URL: `${ownerUrl}?schema=public` })),
      true
    )
    for (const query of [
      "schema=public&schema=other",
      "schema=public&%73chema=other",
      "unknown=value",
    ]) {
      assert.throws(
        () =>
          configureVitestDatabaseEnvironment(fixtureEnv({ DATABASE_URL: `${ownerUrl}?${query}` })),
        /query parameter/
      )
    }
  })

  it("requires explicit opt-in and both URLs for the fixture pair guard", () => {
    assert.throws(
      () =>
        fixtureGuards.assertDisposableDatabasePair(
          fixtureEnv({ LYRASHIELD_TEST_DB_DISPOSABLE: "0" })
        ),
      /explicit.*opt-in/
    )
    assert.throws(
      () => fixtureGuards.assertDisposableDatabasePair(fixtureEnv({ DATABASE_URL: undefined })),
      /DATABASE_URL/
    )
    assert.throws(
      () =>
        fixtureGuards.assertDisposableDatabasePair(
          fixtureEnv({ RLS_RUNTIME_DATABASE_URL: undefined })
        ),
      /RLS_RUNTIME_DATABASE_URL/
    )
  })

  it("accepts the same effective local database with distinct owner and runtime credentials", () => {
    fixtureGuards.assertDisposableDatabasePair(fixtureEnv())
    fixtureGuards.assertDisposableDatabasePair(
      fixtureEnv({
        DATABASE_URL: "postgres://owner:fixture@127.0.0.1/task4_disposable?schema=public",
        RLS_RUNTIME_DATABASE_URL:
          "postgresql://runtime:other@127.0.0.1:5432/task4_%64isposable?schema=public",
      })
    )
    fixtureGuards.assertDisposableDatabasePair(
      fixtureEnv({
        DATABASE_URL: "postgres://owner:fixture@[::1]/task4_disposable",
        RLS_RUNTIME_DATABASE_URL: "postgresql://runtime:other@[::1]:5432/task4_disposable",
      })
    )
  })

  for (const key of [
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
  ]) {
    it(`rejects ambient ${key} before fixture construction and strips it from ordinary units`, () => {
      const env = fixtureEnv({ [key]: "ambient-override" })
      assert.throws(() => configureVitestDatabaseEnvironment(env), /must be unset/)
      assert.throws(() => fixtureGuards.assertDisposableDatabasePair(env), /must be unset/)
      env.LYRASHIELD_TEST_DB_DISPOSABLE = "0"
      assert.equal(configureVitestDatabaseEnvironment(env), false)
      assert.equal(env[key], undefined)
    })
  }

  it("requires explicit credentials and rejects ambiguous encoded database and authority inputs", () => {
    for (const value of [
      "postgres://127.0.0.1/task4_disposable",
      "postgres://owner@127.0.0.1/task4_disposable",
      "postgres://owner:bad%escape@127.0.0.1/task4_disposable",
      "postgres://owner:fixture@%31%32%37.0.0.1/task4_disposable",
      `${ownerUrl}%2fproduction`,
      `${ownerUrl}%252fproduction`,
      `${ownerUrl}/production`,
      "postgres://owner:fixture@127.0.0.1/task4_%ZZdisposable",
    ]) {
      assert.throws(
        () => configureVitestDatabaseEnvironment(fixtureEnv({ DATABASE_URL: value })),
        /credentials|loopback|test database/
      )
    }
    assert.equal(
      configureVitestDatabaseEnvironment(
        fixtureEnv({
          DATABASE_URL: "postgres://own%65r:fix%74ure@127.0.0.1/task4_%64isposable?schema=public",
        })
      ),
      true
    )
  })

  for (const changed of [
    "postgres://runtime:fixture@127.0.0.1:5433/task4_disposable",
    "postgres://runtime:fixture@127.0.0.1:5432/other_disposable",
    "postgres://runtime:fixture@localhost:5432/task4_disposable",
    "postgres://runtime:fixture@remote.example:5432/task4_disposable",
    `${runtimeUrl}?host=remote.example`,
    `${runtimeUrl}?port=6543`,
    `${runtimeUrl}?user=owner`,
    `${runtimeUrl}?password=override`,
    `${runtimeUrl}?dbname=production`,
  ]) {
    it(`rejects mismatched or overridden fixture targets: ${new URL(changed).hostname}`, () => {
      let constructed = false
      assert.throws(() => {
        fixtureGuards.assertDisposableDatabasePair(
          fixtureEnv({ RLS_RUNTIME_DATABASE_URL: changed })
        )
        constructed = true
      }, /same.*database|loopback|query parameter/)
      assert.equal(constructed, false)
    })
  }
})
