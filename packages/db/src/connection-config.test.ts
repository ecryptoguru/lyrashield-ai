import { afterEach, describe, expect, it, vi } from "vitest"
import pg from "pg"
import { X509Certificate } from "node:crypto"
import { getCACertificates } from "node:tls"
import { SUPABASE_ROOT_CA } from "./supabase-ca"
import { createPgConnectionConfig } from "./connection-config"

const authority =
  "postgresql://worker.abcdefghijklmnopqrst:p%40ss@aws-0-test.pooler.supabase.com:5432/postgres"

afterEach(() => vi.unstubAllEnvs())

describe("Supabase runtime TLS", () => {
  it("pins the dashboard CA to Supabase TLS while preserving default trust", () => {
    const certificate = new X509Certificate(SUPABASE_ROOT_CA)
    expect(certificate.ca).toBe(true)
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.subject).toBe(certificate.issuer)
    expect(certificate.fingerprint256.replaceAll(":", "").toLowerCase()).toBe(
      "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa"
    )
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now())
    const defaults = getCACertificates("default")
    const config = createPgConnectionConfig(`${authority}?sslmode=require&uselibpqcompat=true`)
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: [...defaults, SUPABASE_ROOT_CA] })
    expect(getCACertificates("default")).toEqual(defaults)
    const other = "postgres://runtime:synthetic@db.example.com:5432/postgres?sslmode=verify-full"
    expect(createPgConnectionConfig(other)).toEqual({ connectionString: other })
  })

  it("preserves deferred client construction when the database URL is absent", () => {
    expect(createPgConnectionConfig(undefined)).toEqual({ connectionString: undefined })
  })

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
    "sslmode=require&host=aws-0-test.pooler.supabase.com",
    "sslmode=require&host=other.invalid,aws-0-test.pooler.supabase.com",
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

  it("rejects a Supabase destination smuggled through a non-Supabase host override", () => {
    const unrelatedAuthority =
      "postgres://worker:synthetic@db.example.com:5432/postgres?host=aws-0-test.pooler.supabase.com&sslmode=require&uselibpqcompat=true"
    expect(() => createPgConnectionConfig(unrelatedAuthority)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it.each(["%ZZ", "%FF"])(
    "rejects a malformed authority with a Supabase query host (%s)",
    (escape) => {
      const malformedAuthority = `postgres://worker:synthetic@db.${escape}.invalid:5432/postgres?host=aws-0-test.pooler.supabase.com&sslmode=require&uselibpqcompat=true`
      expect(() => createPgConnectionConfig(malformedAuthority)).toThrow(
        "Invalid Supabase database connection configuration"
      )
    }
  )

  it("recognizes percent-encoded query host keys before malformed authorities pass through", () => {
    const malformedAuthority =
      "postgres://worker:synthetic@db.%ZZ.invalid:5432/postgres?%68ost=aws-0-test.pooler.supabase.com&sslmode=require&uselibpqcompat=true"
    expect(() => createPgConnectionConfig(malformedAuthority)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it("rejects an invalid URL authority when pg would use its encoded Supabase host query", () => {
    const malformedUrl =
      "postgres://worker:synthetic@/postgres?host=aws-0-test.pooler.%73upabase.com&sslmode=require&uselibpqcompat=true"
    expect(() => createPgConnectionConfig(malformedUrl)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it.each(["\t", "\n", "\r"])(
    "rejects a Supabase query host whose key normalizes from a literal control character",
    (control) => {
      const normalizedQueryKey = `h${control}ost`
      const url = `postgres://worker:synthetic@db.example.com:5432/postgres?${normalizedQueryKey}=aws-0-test.pooler.supabase.com&sslmode=require&uselibpqcompat=true`
      expect(() => createPgConnectionConfig(url)).toThrow(
        "Invalid Supabase database connection configuration"
      )
    }
  )

  it.each([
    "aws-0-test.pooler.supabase\u3002com",
    "aws-0-test.pooler.\uff53\uff55\uff50\uff41\uff42\uff41\uff53\uff45.com",
  ])("rejects an IDNA-normalized Supabase hostname (%s)", (hostname) => {
    const connectionString = `postgres://worker:synthetic@${hostname}:5432/postgres?sslmode=require&uselibpqcompat=true`
    expect(() => createPgConnectionConfig(connectionString)).toThrow(
      "Invalid Supabase database connection configuration"
    )
  })

  it.each([
    "aws-0-test.pooler.supabase\u3002com",
    "aws-0-test.pooler.\uff53\uff55\uff50\uff41\uff42\uff41\uff53\uff45.com",
  ])("rejects an IDNA-normalized Supabase query host (%s)", (hostname) => {
    const connectionString = `postgres://worker:synthetic@db.example.com:5432/postgres?host=${hostname}&sslmode=require&uselibpqcompat=true`
    expect(() => createPgConnectionConfig(connectionString)).toThrow(
      "Invalid Supabase database connection configuration"
    )
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
