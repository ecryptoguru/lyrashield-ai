import { describe, expect, it, vi } from "vitest"
import { getUrlScanProfile } from "@lyrashield/types"
import { collectPublicSurface, type HostResolver } from "@lyrashield/security"
import { runUrlBehaviorProbes } from "./url-behavior-probes"

const stubResolver: HostResolver = async () => ["93.184.216.34"]

function normalizeRequestHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  const raw = init.headers
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) headers[key.toLowerCase()] = value
  } else if (raw) {
    for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = value
  }
  return headers
}

function buildFixture(responseFor: (method: string, headers: Record<string, string>) => Response) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const headers = normalizeRequestHeaders(init)
    return responseFor(init.method ?? "GET", { ...headers, url })
  })
}

async function deepCollection(fetchFn: ReturnType<typeof buildFixture>) {
  const profile = getUrlScanProfile("WEB_APP", "DEEP")
  return collectPublicSurface({
    seedUrl: "https://example.com/",
    profile,
    fetchFn,
    resolver: stubResolver,
  })
}

describe("runUrlBehaviorProbes", () => {
  it("uses only GET, HEAD, and OPTIONS methods", async () => {
    const recorded: Array<{ method: string; headers: Record<string, string> }> = []
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
      const headers: Record<string, string> = {}
      init.headers?.forEach?.((value: string, key: string) => {
        headers[key.toLowerCase()] = value
      })
      recorded.push({ method: init.method ?? "GET", headers })
      return new Response("", { status: 200 })
    })

    const collection = await deepCollection(fetchFn)
    const result = await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    expect(result.subjects.filter((s) => s.kind === "probe").length).toBeGreaterThan(0)
    expect(new Set(recorded.map((r) => r.method))).toEqual(new Set(["HEAD", "OPTIONS", "GET"]))
    expect(recorded).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST" })]))
  })

  it("detects reflected origin with credentials", async () => {
    const fetchFn = buildFixture((method, headers) => {
      if (method === "GET" && headers["origin"] === "https://lyrashield.invalid") {
        return new Response("", {
          status: 200,
          headers: {
            "access-control-allow-origin": "https://lyrashield.invalid",
            "access-control-allow-credentials": "true",
          },
        })
      }
      return new Response("", { status: 200 })
    })

    const collection = await deepCollection(fetchFn)
    const result = await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    expect(result.signals).toContainEqual(
      expect.objectContaining({
        id: expect.stringContaining("surface.cors-reflected-credentials"),
        controlIds: [14],
        state: "DETECTED",
      })
    )
  })

  it("does not claim wildcard plus credentials is a successful credentialed read", async () => {
    const fetchFn = buildFixture((method, headers) => {
      if (method === "GET" && headers["origin"] === "https://lyrashield.invalid") {
        return new Response("", {
          status: 200,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
          },
        })
      }
      return new Response("", { status: 200 })
    })

    const collection = await deepCollection(fetchFn)
    const result = await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    expect(result.signals.some((signal) => signal.id.includes("cors-reflected-credentials"))).toBe(false)
  })

  it("records a failure issue when a behavior probe fails", async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
      if ((init.method ?? "GET") === "HEAD") throw new Error("connection refused")
      return new Response("", { status: 200 })
    })

    const collection = await deepCollection(fetchFn)
    const result = await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    expect(result.issues.some((i) => i.code === "FETCH_FAILED")).toBe(true)
  })

  it("aborts when the caller signal is cancelled", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
      return new Response("", { status: 200 })
    })

    const controller = new AbortController()
    const collection = await deepCollection(fetchFn)
    const promise = runUrlBehaviorProbes({
      collection,
      fetchFn,
      resolver: stubResolver,
      signal: controller.signal,
    })
    controller.abort()
    const result = await promise

    expect(result.issues.some((i) => i.code === "LIMIT_REACHED")).toBe(true)
  })

  it("caps method and origin probes at the profile limits", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    // Build a collection with more documents than the probe budget allows.
    const profile = getUrlScanProfile("WEB_APP", "DEEP")
    const subjects: Awaited<ReturnType<typeof collectPublicSurface>>["subjects"] = []
    for (let i = 0; i < 25; i++) {
      subjects.push({
        kind: "document",
        requestedUrl: `https://example.com/page-${i}.html`,
        finalUrl: `https://example.com/page-${i}.html`,
        urlHistory: [`https://example.com/page-${i}.html`],
        method: "GET",
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
        bodyBytes: 15,
        bodyTruncated: false,
        depth: 1,
      } as never)
    }

    const collection = {
      contractVersion: "v1",
      profile,
      subjects,
      totalBytes: 15 * 25,
      truncated: false,
      issues: [],
      startTime: Date.now(),
      endTime: Date.now(),
    }

    const result = await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    const methodProbeCount = result.subjects.filter((s) => s.method === "HEAD" || s.method === "OPTIONS").length
    const originProbeCount = result.subjects.filter((s) => s.method === "GET").length

    expect(methodProbeCount).toBe(profile.maxMethodProbes)
    expect(originProbeCount).toBe(profile.maxOriginProbes)
    expect(result.issues.some((i) => i.code === "LIMIT_REACHED")).toBe(true)
  })

  it("does not replay cookies or authorization headers", async () => {
    const recorded: RequestInit[] = []
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
      recorded.push(init)
      return new Response("", { status: 200 })
    })

    const collection = await deepCollection(fetchFn)
    await runUrlBehaviorProbes({ collection, fetchFn, resolver: stubResolver })

    for (const init of recorded) {
      const headers = normalizeRequestHeaders(init)
      expect(headers["cookie"]).toBeUndefined()
      expect(headers["authorization"]).toBeUndefined()
    }
  })
})
