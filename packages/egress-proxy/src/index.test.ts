import { describe, expect, it, afterAll, beforeAll } from "vitest"
import { randomBytes } from "node:crypto"
import { startProxy, type ProxyServer } from "./index"

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
