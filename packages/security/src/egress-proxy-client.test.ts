import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

const warn = vi.hoisted(() => vi.fn())
vi.mock("@lyrashield/logger", () => ({ logger: { warn } }))

import { createEgressProxyFetchFn } from "./egress-proxy-client"
import { EgressProxyError } from "./safe-fetch"

async function withProxy<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

describe("egress proxy fetch client", () => {
  afterEach(() => warn.mockReset())

  it("returns no fetch implementation without both proxy URL and secret", () => {
    expect(createEgressProxyFetchFn({ url: "", secret: "secret" })).toBeUndefined()
    expect(createEgressProxyFetchFn({ url: "http://127.0.0.1:1", secret: "" })).toBeUndefined()
  })

  it("posts only the proxy bearer secret and forwards the per-hop limits", async () => {
    let received: { path?: string; method?: string; authorization?: string; body?: string } = {}
    await withProxy(
      (request, response) => {
        void requestBody(request).then((body) => {
          received = {
            path: request.url,
            method: request.method,
            authorization: request.headers.authorization,
            body,
          }
          response.setHeader("content-type", "application/json")
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                html: "<p>bounded</p>",
                status: 200,
                headers: { "content-type": "text/html" },
                finalUrl: "https://target.example/page",
                urlHistory: ["https://target.example/page"],
                bodyBytes: 14,
                bodyTruncated: false,
              },
            })
          )
        })
      },
      async (baseUrl) => {
        const proxyFetch = createEgressProxyFetchFn({ url: baseUrl, secret: "proxy-only-secret" })!
        const response = await proxyFetch("https://target.example/page", {
          headers: { "user-agent": "LyraShield-Test", authorization: "target-header" },
          timeoutMs: 250,
          maxBytes: 14,
        } as RequestInit)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("<p>bounded</p>")
      }
    )
    expect(received.path).toBe("/v1/fetch")
    expect(received.method).toBe("POST")
    expect(received.authorization).toBe("Bearer proxy-only-secret")
    expect(JSON.parse(received.body!)).toEqual({
      url: "https://target.example/page",
      userAgent: "LyraShield-Test",
      timeoutMs: 250,
      maxBytes: 14,
    })
    expect(received.body).not.toContain("proxy-only-secret")
    expect(received.body).not.toContain("target-header")
  })

  it("maps an SSRF refusal to the typed failure reason", async () => {
    await withProxy(
      (_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ ok: false, reason: "ssrf_blocked", detail: "private IP" }))
      },
      async (baseUrl) => {
        const proxyFetch = createEgressProxyFetchFn({ url: baseUrl, secret: "secret" })!
        await expect(proxyFetch("http://127.0.0.1/private")).rejects.toMatchObject({
          name: "EgressProxyError",
          reason: "ssrf_blocked",
          detail: "private IP",
        } satisfies Partial<EgressProxyError>)
      }
    )
  })

  it("times out a hung proxy and logs only the redacted target URL", async () => {
    await withProxy(
      (request) => request.resume(),
      async (baseUrl) => {
        const proxyFetch = createEgressProxyFetchFn({
          url: baseUrl,
          secret: "secret",
          connectTimeoutMs: 20,
          readTimeoutMs: 20,
        })!
        await expect(
          proxyFetch("https://alice:password@example.com/private?token=secret#fragment")
        ).rejects.toMatchObject({
          name: "EgressProxyError",
          reason: "request_failed",
          detail: expect.stringContaining("timed out after 40ms"),
        })
      }
    )
    expect(warn).toHaveBeenCalledWith(
      "egress proxy request failed",
      expect.objectContaining({ url: "https://example.com/private" })
    )
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/alice|password|token=secret|fragment/)
  })
})

describe("egress proxy response boundary", () => {
  afterEach(() => vi.restoreAllMocks())

  const createFetch = () =>
    createEgressProxyFetchFn({ url: "https://proxy.example.com", secret: "test-token" })!

  it("returns a validated proxy response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: { html: "ok", status: 200, headers: { "content-type": "text/plain" } },
      })
    )

    const response = await createFetch()("https://example.com")
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("ok")
  })

  it.each([
    { ok: true, result: { html: "ok", status: 999, headers: {} } },
    { ok: true, result: { html: "ok", status: 204, headers: {} } },
    { ok: true, result: { html: "ok", status: 200, headers: { "bad name": "x" } } },
    { ok: true, result: { html: "ok", status: 200, headers: { broken: 42 } } },
    { ok: false, reason: "unknown_reason" },
    { ok: true },
  ])("classifies malformed proxy JSON as invalid_response %#", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(body))

    await expect(createFetch()("https://example.com")).rejects.toMatchObject({
      name: "EgressProxyError",
      reason: "invalid_response",
    })
  })
})
