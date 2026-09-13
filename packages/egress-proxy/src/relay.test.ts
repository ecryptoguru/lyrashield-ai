// security-scan-skip-file: relay tests mint grants and stand up loopback fixtures intentionally
import { describe, expect, it, afterAll, beforeAll } from "vitest"
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { mintRelayGrant, type RelayGrantScope } from "@lyrashield/security"
import { startProxy, type ProxyServer } from "./index"
import type { RelayDeps } from "./relay"

const ADMIN = randomBytes(32).toString("hex")
const RELAY_SECRET = randomBytes(32).toString("hex")
const UPSTREAM_HOST = "upstream.test"

function scopeFor(host: string, overrides: Partial<RelayGrantScope> = {}): RelayGrantScope {
  return {
    v: 1,
    scanId: "scan_relay_test",
    hosts: [host],
    methods: ["GET", "HEAD", "OPTIONS", "POST"],
    blockedPaths: ["/admin"],
    exp: Date.now() + 60_000,
    maxRequests: 50,
    maxBytes: 1024 * 1024,
    ratePerMinute: 100,
    perPathPerMinute: 10,
    ...overrides,
  }
}

const grant = (scope: RelayGrantScope) => mintRelayGrant(scope, RELAY_SECRET)

/** Raw forward-proxy request: request line carries the absolute target URL. */
function rawForward(
  relayPort: number,
  absoluteUrl: string,
  token: string | undefined,
  method = "GET"
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, "127.0.0.1", () => {
      const lines = [
        `${method} ${absoluteUrl} HTTP/1.1`,
        `Host: ${new URL(absoluteUrl).host}`,
        ...(token ? [`x-lyra-relay-grant: ${token}`] : []),
        "Connection: close",
        "\r\n",
      ]
      socket.write(lines.join("\r\n"))
    })
    const chunks: Buffer[] = []
    socket.on("data", (c) => chunks.push(c))
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      resolve({ status: Number(raw.split(" ")[1]), raw })
    })
    socket.on("error", reject)
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error("timeout")) })
  })
}

/** CONNECT tunnel through the relay, then a plaintext HTTP request inside it. */
function tunnelRequest(
  relayPort: number,
  authority: string,
  token: string | undefined
): Promise<{ established: boolean; tunneled: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
          (token ? `Proxy-Authorization: Bearer ${token}\r\n` : "") +
          "\r\n"
      )
    })
    let established = false
    let buffer = Buffer.alloc(0)
    let tunneled = ""
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!established) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd === -1) return
        const statusLine = buffer.slice(0, buffer.indexOf("\r\n")).toString()
        established = statusLine.includes("200")
        if (!established) {
          socket.destroy()
          resolve({ established: false, tunneled: statusLine })
          return
        }
        socket.write("GET /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        buffer = buffer.slice(headerEnd + 4)
      } else {
        tunneled += chunk.toString()
      }
    })
    socket.on("close", () => resolve({ established, tunneled }))
    socket.on("error", reject)
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error("timeout")) })
  })
}

describe("scoped relay", () => {
  let upstream: Server
  let upstreamPort: number
  let proxy: ProxyServer

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/echo") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, auth: req.headers["x-test-auth"] ?? null }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    upstreamPort = (upstream.address() as AddressInfo).port

    const relayDeps: RelayDeps = {
      // Test-only: every scoped host pins to the loopback fixture; any port allowed.
      resolveHost: async () => ({ ok: true, addresses: ["127.0.0.1"] }),
      allowedConnectPorts: new Set([80, 443, upstreamPort]),
    }
    proxy = startProxy({ token: ADMIN, port: 0, relaySigningSecret: RELAY_SECRET, relayDeps })
    await proxy.ready
  })

  afterAll(async () => {
    await proxy.close()
    upstream.close()
  })

  it("forwards an in-scope request and records audit", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST))
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(res.status).toBe(200)
    expect(res.raw).toContain('"ok":true')

    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_relay_test`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json() as Promise<{ entries: { path?: string; status?: number }[] }>)
    expect(audit.entries.some((e) => e.path === "/echo" && e.status === 200)).toBe(true)
  })

  it("injects credential headers server-side without leaking the grant", async () => {
    const token = grant(
      scopeFor(UPSTREAM_HOST, {
        scanId: "scan_inject",
        injectHeaders: { "x-test-auth": "super-secret-value" },
      })
    )
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(res.status).toBe(200)
    expect(res.raw).toContain("super-secret-value")
    // The grant token itself must never reach the target.
    expect(res.raw).not.toContain("lrg1.")
  })

  it("rejects forward requests with no grant", async () => {
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, undefined)
    expect(res.status).toBe(403)
    expect(res.raw).toContain("malformed")
  })

  it("rejects out-of-scope hosts", async () => {
    const token = grant(scopeFor("allowed.example.com"))
    const res = await rawForward(proxy.port, `http://other.example.com:${upstreamPort}/echo`, token)
    expect(res.status).toBe(403)
    expect(res.raw).toContain("host_out_of_scope")
  })

  it("rejects methods outside the grant", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST))
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token, "DELETE")
    expect(res.status).toBe(403)
    expect(res.raw).toContain("method_not_allowed")
  })

  it("rejects blocked paths", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST))
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/admin/x`, token)
    expect(res.status).toBe(403)
    expect(res.raw).toContain("path_blocked")
  })

  it("enforces the request cap", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_capped", maxRequests: 2 }))
    const url = `http://${UPSTREAM_HOST}:${upstreamPort}/echo`
    await rawForward(proxy.port, url, token)
    await rawForward(proxy.port, url, token)
    const third = await rawForward(proxy.port, url, token)
    expect(third.status).toBe(403)
    expect(third.raw).toContain("request_cap")
  })

  it("rejects revoked grants immediately", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_revoke_me" }))
    const before = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(before.status).toBe(200)
    await fetch(`http://127.0.0.1:${proxy.port}/v1/revoke/scan_revoke_me`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
    const after = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(after.status).toBe(403)
    expect(after.raw).toContain("revoked")
  })

  it("rejects admin endpoints without the admin token", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_relay_test`)
    expect(res.status).toBe(401)
    const revoke = await fetch(`http://127.0.0.1:${proxy.port}/v1/revoke/x`, { method: "POST" })
    expect(revoke.status).toBe(401)
  })

  it("tunnels CONNECT to a scoped host and audits it", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_tunnel" }))
    const res = await tunnelRequest(proxy.port, `${UPSTREAM_HOST}:${upstreamPort}`, token)
    expect(res.established).toBe(true)
    expect(res.tunneled).toContain('"ok":true')
    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_tunnel`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json() as Promise<{ entries: { type?: string; host?: string }[] }>)
    expect(audit.entries.some((e) => e.type === "tunnel" && e.host === UPSTREAM_HOST)).toBe(true)
  })

  it("rejects CONNECT to out-of-scope hosts and non-web ports", async () => {
    const outOfScope = await tunnelRequest(proxy.port, "evil.example.com:443", grant(scopeFor(UPSTREAM_HOST)))
    expect(outOfScope.established).toBe(false)
    const badPort = await tunnelRequest(
      proxy.port,
      `${UPSTREAM_HOST}:22`,
      grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_badport" }))
    )
    expect(badPort.established).toBe(false)
  })
})
