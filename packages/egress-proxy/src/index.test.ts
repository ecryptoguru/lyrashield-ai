import { describe, expect, it, afterAll, beforeAll, vi } from "vitest"
import { randomBytes } from "node:crypto"
import { startProxy, type ProxyServer } from "./index"

vi.mock("@lyrashield/security/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/security/safe-fetch")>()
  return {
    ...actual,
    safeFetchOnce: vi.fn(
      async (url: string, options?: Parameters<typeof actual.safeFetchOnce>[1]) =>
        url === "https://example.com/"
          ? {
              ok: true as const,
              result: {
                url,
                status: 200,
                contentType: "text/html",
                html: "<html><body>Example Domain</body></html>",
              },
            }
          : actual.safeFetchOnce(url, options)
    ),
  }
})

const fetchJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe("egress proxy", () => {
  let proxy: ProxyServer
  const token = randomBytes(32).toString("hex")

  beforeAll(async () => {
    proxy = startProxy({ token, port: 0 })
    await proxy.ready
  })

  afterAll(async () => {
    await proxy.close()
  })

  it("reports relay unavailable while keeping ordinary proxy health ready", async () => {
    expect((await fetch(`http://localhost:${proxy.port}/health`)).status).toBe(200)
    expect(await fetchJson(`http://localhost:${proxy.port}/health/relay`)).toEqual({
      status: 503,
      body: { relay: false },
    })
  })

  it("reports only a boolean capability when the relay is configured", async () => {
    const enabled = startProxy({ token, port: 0, relaySigningSecret: "test-relay-secret" })
    await enabled.ready
    try {
      expect(await fetchJson(`http://localhost:${enabled.port}/health/relay`)).toEqual({
        status: 200,
        body: { relay: true },
      })
    } finally {
      await enabled.close()
    }
  })

  it("rejects requests without authorization", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    })
    expect(status).toBe(401)
    expect(body.ok).toBe(false)
  })

  it("rejects non-POST methods", async () => {
    const res = await fetch(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(405)
  })

  it("fetches an external target and returns the body", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "https://example.com/" }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof (body.result as Record<string, unknown>)?.html).toBe("string")
    expect((body.result as Record<string, unknown>).html).toContain("Example Domain")
  })

  it("accepts a zero-byte body budget for header-only behavior probes", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "https://example.com/", maxBytes: 0 }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it("returns a structured error for an unreachable target", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "http://8.8.8.8:1/", timeoutMs: 2000 }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe("request_failed")
  })

  it("rejects hostnames that resolve to a blocked IP", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "http://127.0.0.1:12345/" }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe("ssrf_blocked")
  })

  it("rejects a non-HTTP URL", async () => {
    const { status, body } = await fetchJson(`http://localhost:${proxy.port}/v1/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.reason).toBe("ssrf_blocked")
  })
})
