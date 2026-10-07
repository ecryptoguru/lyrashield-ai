import { afterEach, describe, expect, it, vi } from "vitest"
import pg from "pg"
import { createPgConnectionConfig } from "./connection-config"

const authority =
  "postgresql://worker.abcdefghijklmnopqrst:p%40ss@aws-0-test.pooler.supabase.com:5432/postgres"

afterEach(() => vi.unstubAllEnvs())

describe("Supabase runtime TLS", () => {
  it("rejects port zero instead of allowing pg to substitute its default", () => {
    expect(() =>
      createPgConnectionConfig(`${authority.replace(":5432/", ":0/")}?sslmode=require`)
    ).toThrow("Invalid Supabase database connection configuration")
  })

  it("rejects a global certificate verification bypass", () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    expect(() => createPgConnectionConfig(`${authority}?sslmode=require`)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it("enforces certificate and hostname verification despite legacy libpq URL options", () => {
    const raw = `${authority}?sslmode=require&uselibpqcompat=true`
    const config = createPgConnectionConfig(raw)
    expect(config).not.toHaveProperty("connectionString")
    const client = new pg.Client(config)
    expect(client.ssl).toMatchObject({ rejectUnauthorized: true })
    expect(client.host).toBe("aws-0-test.pooler.supabase.com")
    expect(client.user).toBe("worker.abcdefghijklmnopqrst")
    expect(client.password).toBe("p@ss")
    expect(client.database).toBe("postgres")
    expect(client.port).toBe(5432)
    expect(raw).toBe(`${authority}?sslmode=require&uselibpqcompat=true`)
  })

  it.each(["true", "false", "1"])("retains verified TLS for compatibility value %s", (compat) => {
    const config = createPgConnectionConfig(
      `${authority}?sslmode=verify-full&uselibpqcompat=${compat}`
    )
    expect(new pg.Client(config).ssl).toMatchObject({ rejectUnauthorized: true })
  })

  it.each([
    "sslmode=disable",
    "sslmode=no-verify",
    "sslmode=prefer",
    "sslmode=verify-ca",
    "",
    "sslmode=require&sslmode=verify-full",
    "sslmode=require&host=other.invalid",
    "sslmode=require&user=postgres",
    "sslmode=require&password=other",
    "sslmode=require&sslrootcert=/unapproved",
    "sslmode=require&ssl=false",
    "sslmode=require&options=-c%20search_path%3Dother",
    "sslmode=require&uselibpqcompat=unknown",
  ])("rejects ambiguous or unsupported configuration without leaking it (%s)", (query) => {
    expect(() => createPgConnectionConfig(`${authority}?${query}`)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it("rejects a trailing-dot Supabase hostname and fragments", () => {
    expect(() =>
      createPgConnectionConfig(`${authority.replace(".com:", ".com.:")}?sslmode=require`)
    ).toThrow()
    expect(() =>
      createPgConnectionConfig(`${authority}?sslmode=require#synthetic-secret`)
    ).toThrow()
  })

  it("rejects a percent-encoded Supabase hostname before pg can decode it", () => {
    const encoded = authority.replace(".com:", "%2ecom:")
    expect(() =>
      createPgConnectionConfig(`${encoded}?sslmode=require&uselibpqcompat=true`)
    ).toThrow("Invalid Supabase database connection configuration")
  })

  it("preserves direct Supabase identity and the ordinary disposable loopback path", () => {
    const direct = createPgConnectionConfig(
      "postgres://runtime:synthetic@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require"
    )
    expect(direct.host).toBe("db.abcdefghijklmnopqrst.supabase.co")
    expect(direct.ssl).toMatchObject({ rejectUnauthorized: true })
    const local = "postgres://runtime:synthetic@127.0.0.1:5432/postgres"
    expect(createPgConnectionConfig(local)).toEqual({ connectionString: local })
  })
})
