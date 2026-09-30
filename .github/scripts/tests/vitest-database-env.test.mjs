import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { configureVitestDatabaseEnvironment } from "../vitest-database-env.mjs"

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
})
