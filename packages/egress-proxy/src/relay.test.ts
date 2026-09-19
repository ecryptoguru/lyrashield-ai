// security-scan-skip-file: relay tests mint grants and stand up loopback fixtures intentionally
import { describe, expect, it, afterAll, beforeAll } from "vitest"
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import net from "node:net"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { mintRelayGrant, type RelayGrantScope } from "@lyrashield/security"
import { startProxy, type ProxyServer } from "./index"
import type { RelayDeps } from "./relay"

const ADMIN = randomBytes(32).toString("hex")
const RELAY_SECRET = randomBytes(32).toString("hex")
const UPSTREAM_HOST = "upstream.test"
let nextScan = 0

function scopeFor(host: string, overrides: Partial<RelayGrantScope> = {}): RelayGrantScope {
  return {
    v: 1,
    scanId: `scan_relay_test_${nextScan++}`,
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

let registerFixtureGrant: (scanId: string, token: string) => void = () => {}
const grant = (scope: RelayGrantScope) => {
  const token = mintRelayGrant(scope, RELAY_SECRET)
  registerFixtureGrant(scope.scanId, token)
  return token
}

/** Raw forward-proxy request: request line carries the absolute target URL. */
function rawForward(
  relayPort: number,
  absoluteUrl: string,
  token: string | undefined,
  method = "GET",
  body = ""
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, "127.0.0.1", () => {
      const lines = [
        `${method} ${absoluteUrl} HTTP/1.1`,
        `Host: ${new URL(absoluteUrl).host}`,
        ...(token ? [`x-lyra-relay-grant: ${token}`] : []),
        ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
        "Connection: close",
        "\r\n",
      ]
      socket.write(lines.join("\r\n") + body)
    })
    const chunks: Buffer[] = []
    socket.on("data", (c) => chunks.push(c))
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      resolve({ status: Number(raw.split(" ")[1]), raw })
    })
    socket.on("error", reject)
    socket.setTimeout(8000, () => {
      socket.destroy()
      reject(new Error("timeout"))
    })
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
    socket.setTimeout(8000, () => {
      socket.destroy()
      reject(new Error("timeout"))
    })
  })
}

describe("scoped relay", () => {
  let upstream: Server
  let upstreamPort: number
  let httpsUpstream: Server
  let httpsPort: number
  let activeStreams = 0
  let tlsDirectory: string
  let proxy: ProxyServer

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/echo") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, grant: req.headers["x-lyra-relay-grant"] ?? null }))
      } else if (req.url === "/echo-auth") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            ok: true,
            authorization: req.headers["authorization"] ?? null,
            cookie: req.headers["cookie"] ?? null,
            grant: req.headers["x-lyra-relay-grant"] ?? null,
          })
        )
      } else if (req.url === "/stream") {
        activeStreams++
        res.writeHead(200)
        res.write("0123456789")
        const timer = setInterval(() => res.write("0123456789"), 20)
        res.once("close", () => {
          clearInterval(timer)
          activeStreams--
        })
      } else if (req.url === "/big") {
        // Declared length beyond the relay's response cap.
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Content-Length": String(11 * 1024 * 1024),
        })
        res.end("x".repeat(1024))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    upstreamPort = (upstream.address() as AddressInfo).port

    tlsDirectory = mkdtempSync(join(tmpdir(), "lyra-relay-tls-"))
    const keyPath = join(tlsDirectory, "key.pem")
    const certPath = join(tlsDirectory, "cert.pem")
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "2",
        "-subj",
        `/CN=${UPSTREAM_HOST}`,
        "-addext",
        `subjectAltName=DNS:${UPSTREAM_HOST}`,
      ],
      { stdio: "ignore" }
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- generated private test directory
    const tlsKey = readFileSync(keyPath, "utf8")
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- generated private test directory
    const tlsCert = readFileSync(certPath, "utf8")
    httpsUpstream = createHttpsServer({ key: tlsKey, cert: tlsCert }, (_req, res) =>
      res.end("secure-target")
    )
    await new Promise<void>((resolve) => httpsUpstream.listen(0, "127.0.0.1", resolve))
    httpsPort = (httpsUpstream.address() as AddressInfo).port
    const relayDeps: RelayDeps = {
      ca: tlsCert,
      // Test-only: every scoped host pins to the loopback fixture; any port allowed.
      resolveHost: async () => ({ ok: true, addresses: ["127.0.0.1"] }),
      allowedForwardPorts: new Set([80, 443, upstreamPort, httpsPort]),
    }
    proxy = startProxy({ token: ADMIN, port: 0, relaySigningSecret: RELAY_SECRET, relayDeps })
    await proxy.ready
    registerFixtureGrant = (scanId, token) => {
      proxy.relay?.register(scanId, token)
    }
  })

  afterAll(async () => {
    await proxy.close()
    upstream.close()
    httpsUpstream.close()
    rmSync(tlsDirectory, { recursive: true, force: true })
  })

  it("requires admin registration and fails closed after process replacement", async () => {
    const scope = scopeFor(UPSTREAM_HOST, { maxRequests: 1 })
    const token = mintRelayGrant(scope, RELAY_SECRET)
    const url = `http://${UPSTREAM_HOST}:${upstreamPort}/echo`
    expect((await rawForward(proxy.port, url, token)).raw).toContain("unregistered_grant")
    const endpoint = `http://127.0.0.1:${proxy.port}/v1/register/${scope.scanId}`
    expect(
      (await fetch(endpoint, { method: "POST", headers: { "x-lyra-relay-grant": token } })).status
    ).toBe(401)
    const register = () =>
      fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN}`, "x-lyra-relay-grant": token },
      })
    expect((await register()).status).toBe(200)
    expect((await rawForward(proxy.port, url, token)).status).toBe(200)
    // Repeating trusted admission is idempotent; it never resets counters.
    expect((await register()).status).toBe(200)
    expect((await rawForward(proxy.port, url, token)).raw).toContain("request_cap")
    const replacement = startProxy({ token: ADMIN, port: 0, relaySigningSecret: RELAY_SECRET })
    await replacement.ready
    try {
      expect((await rawForward(replacement.port, url, token)).raw).toContain("unregistered_grant")
    } finally {
      await replacement.close()
    }
  })

  it("forwards an in-scope request and records audit", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_relay_test" }))
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(res.status).toBe(200)
    expect(res.raw).toContain('"ok":true')

    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_relay_test`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json() as Promise<{ entries: { path?: string; status?: number }[] }>)
    expect(audit.entries.some((e) => e.path === "/echo" && e.status === 200)).toBe(true)
  })

  it("records audit paths without query strings", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_query_redact" }))
    // Forwarded request whose query carries a credential-like parameter.
    await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/login?token=abc`, token)
    // Denied request: the query must not reach the audit trail either.
    await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/admin/x?token=abc`, token)

    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_query_redact`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json() as Promise<{ entries: { path?: string }[] }>)
    expect(audit.entries.some((e) => e.path === "/login")).toBe(true)
    expect(audit.entries.some((e) => e.path === "/admin/x")).toBe(true)
    expect(audit.entries.every((e) => !e.path || !e.path.includes("token"))).toBe(true)
  })

  it("strips the grant before contacting the target", async () => {
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      grant(scopeFor(UPSTREAM_HOST))
    )
    expect(res.status).toBe(200)
    expect(res.raw).toContain('"grant":null')
  })

  it("rejects forward requests with no grant", async () => {
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      undefined
    )
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
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token,
      "DELETE"
    )
    expect(res.status).toBe(403)
    expect(res.raw).toContain("method_not_allowed")
  })

  it("rejects blocked paths", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST))
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/admin/x`,
      token
    )
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

  it("shares per-path rate limits across encoded aliases", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { perPathPerMinute: 1 }))
    const first = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token
    )
    expect(first.status).toBe(200)
    const second = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/%65cho`,
      token
    )
    expect(second.status).toBe(403)
    expect(second.raw).toContain("rate_limited")
  })

  it("rejects scope replacement for an already active scan", async () => {
    const scope = scopeFor(UPSTREAM_HOST)
    await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, grant(scope))
    const replaced = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      grant({ ...scope, maxRequests: 100 })
    )
    expect(replaced.status).toBe(403)
    expect(replaced.raw).toContain("scope_changed")
  })

  it("rejects revoked grants immediately", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_revoke_me" }))
    const before = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token
    )
    expect(before.status).toBe(200)
    await fetch(`http://127.0.0.1:${proxy.port}/v1/revoke/scan_revoke_me`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
    const after = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token
    )
    expect(after.status).toBe(403)
    expect(after.raw).toContain("revoked")
  })

  it("rejects admin endpoints without the admin token", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_relay_test`)
    expect(res.status).toBe(401)
    const revoke = await fetch(`http://127.0.0.1:${proxy.port}/v1/revoke/x`, { method: "POST" })
    expect(revoke.status).toBe(401)
  })

  it("enforces method and path scope for inspectable HTTPS requests", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST))
    const blocked = await rawForward(proxy.port, `https://${UPSTREAM_HOST}/admin`, token)
    expect(blocked.status).toBe(403)
    expect(blocked.raw).toContain("path_blocked")
    const denied = await rawForward(proxy.port, `https://${UPSTREAM_HOST}/echo`, token, "DELETE")
    expect(denied.raw).toContain("method_not_allowed")
  })

  it("forwards inspectable HTTPS with certificate validation and DNS pinning", async () => {
    const result = await rawForward(
      proxy.port,
      `https://${UPSTREAM_HOST}:${httpsPort}/echo`,
      grant(scopeFor(UPSTREAM_HOST))
    )
    expect(result.status).toBe(200)
    expect(result.raw).toContain("secure-target")
  })

  it("rejects an HTTPS target whose certificate does not match its scoped hostname", async () => {
    const result = await rawForward(
      proxy.port,
      `https://wrong.test:${httpsPort}/echo`,
      grant(scopeFor("wrong.test"))
    )
    expect(result.status).toBe(502)
    expect(result.raw).toContain("upstream_failed")
  })

  it("stops active responses at grant expiry", async () => {
    const result = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/stream`,
      grant(scopeFor(UPSTREAM_HOST, { exp: Date.now() + 150 }))
    )
    expect(result.status).toBe(200)
    await expect.poll(() => activeStreams).toBe(0)
  })

  it("aborts an active response immediately on revocation", async () => {
    const pending = rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/stream`,
      grant(scopeFor(UPSTREAM_HOST, { scanId: "active_revoke" }))
    )
    await expect.poll(() => activeStreams).toBe(1)
    proxy.relay?.revoke("active_revoke")
    await pending
    await expect.poll(() => activeStreams).toBe(0)
  })

  it("accounts concurrent stream bytes against one scan cap", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "concurrent_bytes", maxBytes: 35 }))
    const responses = await Promise.all(
      [0, 1].map(() =>
        rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/stream`, token)
      )
    )
    expect(responses.every((response) => response.status === 200)).toBe(true)
    const audit = proxy.relay?.getAudit("concurrent_bytes") ?? []
    expect(
      audit
        .filter((entry) => entry.type === "request")
        .reduce((total, entry) => total + (entry.bytes ?? 0), 0)
    ).toBe(30)
    expect(audit.filter((entry) => entry.truncated)).toHaveLength(2)
    await expect.poll(() => activeStreams).toBe(0)
  })

  it("rejects request bodies exceeding the remaining shared byte budget", async () => {
    const result = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      grant(scopeFor(UPSTREAM_HOST, { maxBytes: 4 })),
      "POST",
      "12345"
    )
    expect(result.status).toBe(403)
    expect(result.raw).toContain("byte_cap")
  })

  it("denies arbitrary forward ports", async () => {
    const response = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:22/echo`,
      grant(scopeFor(UPSTREAM_HOST))
    )
    expect(response.status).toBe(403)
    expect(response.raw).toContain("port_not_allowed")
  })

  it("denies upstream bodies that declare more bytes than the caps", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_big" }))
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/big`, token)
    expect(res.status).toBe(403)
    expect(res.raw).toContain("byte_cap")
  })

  it("keeps the audit trail after revocation + sweep", async () => {
    const token = grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_retain" }))
    await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    await fetch(`http://127.0.0.1:${proxy.port}/v1/revoke/scan_retain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    })
    proxy.relay?._sweep()
    const retry = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token
    )
    expect(retry.status).toBe(403)
    expect(retry.raw).toContain("revoked")
    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_retain`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json() as Promise<{ entries: { type?: string; path?: string }[] }>)
    expect(audit.entries.some((e) => e.type === "request" && e.path === "/echo")).toBe(true)
  })

  it("rejects opaque CONNECT even for scoped hosts", async () => {
    const res = await tunnelRequest(
      proxy.port,
      `${UPSTREAM_HOST}:${upstreamPort}`,
      grant(scopeFor(UPSTREAM_HOST))
    )
    expect(res.established).toBe(false)
    expect(res.tunneled).toContain("connect_not_supported")
  })

  it("rejects CONNECT to out-of-scope hosts and non-web ports", async () => {
    const outOfScope = await tunnelRequest(
      proxy.port,
      "evil.example.com:443",
      grant(scopeFor(UPSTREAM_HOST))
    )
    expect(outOfScope.established).toBe(false)
    const badPort = await tunnelRequest(
      proxy.port,
      `${UPSTREAM_HOST}:22`,
      grant(scopeFor(UPSTREAM_HOST, { scanId: "scan_badport" }))
    )
    expect(badPort.established).toBe(false)
  })

  it("injects the registered session headers on in-scope requests only", async () => {
    const scope = scopeFor(UPSTREAM_HOST, {
      scanId: "scan_session",
      hosts: [UPSTREAM_HOST, "other.test"],
      methods: ["GET", "HEAD", "OPTIONS"],
    })
    const token = mintRelayGrant(scope, RELAY_SECRET)
    const registered = proxy.relay?.register(scope.scanId, token, {
      headers: { authorization: "Bearer test-session-material" },
      hosts: [UPSTREAM_HOST],
      exp: scope.exp - 1_000,
    })
    expect(registered).toEqual({ ok: true })

    const withSession = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo-auth`,
      token
    )
    expect(withSession.status).toBe(200)
    expect(withSession.raw).toContain('"authorization":"Bearer test-session-material"')
    // The grant itself stays credential-free end to end.
    expect(withSession.raw).toContain('"grant":null')

    // A different grant-scoped host receives the request but no session.
    const otherHost = await rawForward(
      proxy.port,
      `http://other.test:${upstreamPort}/echo-auth`,
      token
    )
    expect(otherHost.status).toBe(200)
    expect(otherHost.raw).toContain('"authorization":null')
  })

  it("denies the request when the registered session expired — a bounded stop", async () => {
    const scope = scopeFor(UPSTREAM_HOST, { scanId: "scan_session_expired" })
    const token = mintRelayGrant(scope, RELAY_SECRET)
    // Registration races the expiry: mint the binding valid, then let it lapse.
    const exp = Math.min(scope.exp - 1_000, Date.now() + 40)
    expect(
      proxy.relay?.register(scope.scanId, token, {
        headers: { cookie: "s=test" },
        hosts: [UPSTREAM_HOST],
        exp,
      })
    ).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo-auth`,
      token
    )
    expect(res.status).toBe(403)
    expect(res.raw).toContain("session_expired")
  })

  it("rejects a session binding that outlives or outscopes the grant", async () => {
    const scope = scopeFor(UPSTREAM_HOST, { scanId: "scan_session_bad" })
    const token = mintRelayGrant(scope, RELAY_SECRET)
    const withinGrant = scope.exp - 1_000
    expect(
      proxy.relay?.register(scope.scanId, token, {
        headers: { authorization: "Bearer x" },
        hosts: ["evil.example.com"],
        exp: withinGrant,
      })
    ).toEqual({ ok: false, reason: "session_out_of_scope" })
    expect(
      proxy.relay?.register(scope.scanId, token, {
        headers: { authorization: "Bearer x" },
        hosts: [UPSTREAM_HOST],
        exp: scope.exp + 60_000,
      })
    ).toEqual({ ok: false, reason: "session_out_of_scope" })
    expect(
      proxy.relay?.register(scope.scanId, token, {
        headers: { "x-forwarded-for": "1.2.3.4" },
        hosts: [UPSTREAM_HOST],
        exp: withinGrant,
      })
    ).toEqual({ ok: false, reason: "session_header_not_allowed" })
    // Registration failed closed — no state was admitted for the scan.
    const res = await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo`, token)
    expect(res.raw).toContain("unregistered_grant")
  })

  it("denies non-read methods under the beta grant — POST never forwards", async () => {
    const scope = scopeFor(UPSTREAM_HOST, {
      scanId: "scan_beta_methods",
      methods: ["GET", "HEAD", "OPTIONS"],
      maxRequests: 25,
      maxBytes: 25 * 1_048_576,
      maxResponseBytes: 1_048_576,
    })
    const token = grant(scope)
    const res = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token,
      "POST",
      "name=value"
    )
    expect(res.status).toBe(403)
    expect(res.raw).toContain("method_not_allowed")
    const put = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/echo`,
      token,
      "PUT"
    )
    expect(put.status).toBe(403)
  })

  it("stops the beta scan at the exact request and response caps with explicit reasons", async () => {
    const scope = scopeFor(UPSTREAM_HOST, {
      scanId: "scan_beta_caps",
      methods: ["GET", "HEAD", "OPTIONS"],
      maxRequests: 25,
      maxBytes: 25 * 1_048_576,
      maxResponseBytes: 1_048_576,
      perPathPerMinute: 60,
    })
    const token = grant(scope)
    const url = `http://${UPSTREAM_HOST}:${upstreamPort}/echo`
    for (let i = 0; i < 25; i++) {
      expect((await rawForward(proxy.port, url, token)).status).toBe(200)
    }
    const twentySixth = await rawForward(proxy.port, url, token)
    expect(twentySixth.status).toBe(403)
    expect(twentySixth.raw).toContain("request_cap")
    // The per-response cap denies a declared-oversize body outright.
    const big = await rawForward(
      proxy.port,
      `http://${UPSTREAM_HOST}:${upstreamPort}/big`,
      grant(
        scopeFor(UPSTREAM_HOST, {
          scanId: "scan_beta_bytes",
          methods: ["GET"],
          maxRequests: 25,
          maxBytes: 25 * 1_048_576,
          maxResponseBytes: 1_048_576,
        })
      )
    )
    expect(big.status).toBe(403)
    expect(big.raw).toContain("byte_cap")
  })

  it("keeps session material out of the audit trail", async () => {
    const scope = scopeFor(UPSTREAM_HOST, { scanId: "scan_session_audit" })
    const token = mintRelayGrant(scope, RELAY_SECRET)
    proxy.relay?.register(scope.scanId, token, {
      headers: { authorization: "Bearer test-session-material" },
      hosts: [UPSTREAM_HOST],
      exp: scope.exp - 1_000,
    })
    await rawForward(proxy.port, `http://${UPSTREAM_HOST}:${upstreamPort}/echo-auth`, token)
    const audit = await fetch(`http://127.0.0.1:${proxy.port}/v1/audit/scan_session_audit`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.text())
    expect(audit).toContain("/echo-auth")
    expect(audit).not.toContain("test-session-material")
    expect(audit).not.toContain("authorization")
  })
})
