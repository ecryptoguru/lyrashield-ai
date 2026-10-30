import { afterEach, describe, expect, it, vi } from "vitest"
import { InMemoryAdvisoryCache, setAdvisoryCache } from "./advisory-cache-service"
import { queryOsvWithCache, type OsvQueryPackage } from "./osv-client"

const pkg: OsvQueryPackage = {
  ecosystem: "npm",
  name: "example",
  version: "1.2.3",
  filePath: "package-lock.json",
}
// Use the real current time as the test's "now" so the InMemoryAdvisoryCache TTL
// check (Date.now() - entry.fetchedAt > TTL_MS) does not evict the entry the
// test just wrote. A hardcoded past date eventually ages past the 24h TTL and
// makes the cache miss -> UNAVAILABLE, which is the real flake. (Deep Review v13.)
const now = new Date()

afterEach(() => {
  setAdvisoryCache(new InMemoryAdvisoryCache())
  vi.useRealTimers()
})

describe("queryOsvWithCache", () => {
  it("returns a complete fresh receipt for a clean exact package", async () => {
    const result = await queryOsvWithCache([pkg], {
      now,
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
    })

    expect(result).toMatchObject({ status: "COMPLETE", resolvedCount: 1, requestedCount: 1 })
    expect(result.results[0]?.vulns).toEqual([])
    expect(result.snapshotChecksum).toHaveLength(64)
  })

  it("does not turn an outage or malformed partial batch into a clean result", async () => {
    const unavailable = await queryOsvWithCache([pkg], {
      now,
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async () => new Response("down", { status: 503 }),
    })
    const malformed = await queryOsvWithCache([pkg], {
      now,
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    })

    expect(unavailable).toMatchObject({
      status: "UNAVAILABLE",
      resolvedCount: 0,
      snapshotChecksum: null,
    })
    expect(malformed).toMatchObject({
      status: "UNAVAILABLE",
      resolvedCount: 0,
      snapshotChecksum: null,
    })
  })

  it("uses a fresh cached complete answer without changing the receipt checksum", async () => {
    const cache = new InMemoryAdvisoryCache()
    // Pass the cache directly via options.cache so the test does not depend on
    // the module-global advisory cache, which can race across parallel test
    // files (setAdvisoryCache mutates a shared global). (Deep Review v13.)
    const first = await queryOsvWithCache([pkg], {
      now,
      cache,
      fetchFn: async () =>
        new Response(
          JSON.stringify({ results: [{ vulns: [{ id: "GHSA-test", affected: [] }] }] }),
          {
            status: 200,
          }
        ),
    })
    const second = await queryOsvWithCache([pkg], {
      now: new Date(now.getTime() + 1_000),
      cache,
      fetchFn: async () => {
        throw new Error("network should not be used")
      },
    })

    expect(second.status).toBe("COMPLETE")
    expect(second.snapshotChecksum).toBe(first.snapshotChecksum)
  })
})

const composerPackage: OsvQueryPackage = {
  ecosystem: "Packagist",
  name: "symfony/process",
  version: "6.4.32",
  filePath: "api/composer.lock",
}
const composerAdvisory = {
  id: "GHSA-r39x-jcww-82v6",
  summary: "Argument escaping on Windows",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { name: "symfony/process", ecosystem: "Packagist" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "6.4" }, { fixed: "6.4.33" }] }],
    },
  ],
}

it("hydrates real OSV batch IDs once before caching their complete advisory snapshot", async () => {
  const calls: string[] = []
  const cache = new InMemoryAdvisoryCache()
  const result = await queryOsvWithCache(
    [composerPackage, { ...composerPackage, filePath: "other/composer.lock" }],
    {
      cache,
      fetchFn: async (url) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify(
            String(url).endsWith("/querybatch")
              ? {
                  results: [
                    { vulns: [{ id: composerAdvisory.id, modified: "2026-10-25T00:00:00Z" }] },
                  ],
                }
              : composerAdvisory
          )
        )
      },
    }
  )
  expect(result.status).toBe("COMPLETE")
  expect(result.results[0]?.vulns[0]).toMatchObject(composerAdvisory)
  expect(calls).toEqual([
    "https://api.osv.dev/v1/querybatch",
    "https://api.osv.dev/v1/vulns/" + composerAdvisory.id,
  ])
  const cached = await queryOsvWithCache([composerPackage], {
    cache,
    fetchFn: async () => {
      throw new Error("cache should avoid network")
    },
  })
  expect(cached.status).toBe("COMPLETE")
  expect(cached.snapshotChecksum).toBe(result.snapshotChecksum)
})

it.each(["unavailable", "mismatch", "malformed", "oversized"])(
  "retains advisory detection with incomplete coverage when details are %s",
  async (failure) => {
    const cache = new InMemoryAdvisoryCache()
    const result = await queryOsvWithCache([composerPackage], {
      cache,
      fetchFn: async (url) => {
        if (String(url).endsWith("/querybatch"))
          return new Response(
            JSON.stringify({ results: [{ vulns: [{ id: composerAdvisory.id }] }] })
          )
        if (failure === "unavailable") return new Response("down", { status: 503 })
        if (failure === "mismatch")
          return new Response(JSON.stringify({ ...composerAdvisory, id: "GHSA-wrong-record" }))
        if (failure === "malformed")
          return new Response(JSON.stringify({ ...composerAdvisory, affected: "invalid" }))
        return new Response(
          JSON.stringify({ ...composerAdvisory, details: "x".repeat(1024 * 1024) })
        )
      },
    })
    expect(result.status).toBe("PARTIAL")
    expect(result.results[0]?.vulns).toEqual([{ id: composerAdvisory.id }])
    expect(result.unresolved).not.toHaveLength(0)
    expect(result.snapshotChecksum).toBeNull()
    expect(await cache.get("Packagist", "symfony/process", "6.4.32")).toBeUndefined()
  }
)

it("does not treat a paginated batch as complete", async () => {
  const result = await queryOsvWithCache([composerPackage], {
    cache: new InMemoryAdvisoryCache(),
    fetchFn: async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/querybatch")
            ? { results: [{ vulns: [composerAdvisory], next_page_token: "more" }] }
            : composerAdvisory
        )
      ),
  })
  expect(result.status).toBe("PARTIAL")
  expect(result.results[0]?.vulns[0]?.id).toBe(composerAdvisory.id)
  expect(result.unresolved[0]?.reason).toMatch(/pagination/i)
})

it.each(["osv-querybatch/1", "osv-querybatch/2"])(
  "refreshes a legacy %s advisory cache",
  async (schemaVersion) => {
    const cache = new InMemoryAdvisoryCache()
    await cache.set({
      ecosystem: "Packagist",
      name: composerPackage.name,
      version: composerPackage.version,
      vulns: [],
      source: "osv",
      fetchedAt: new Date(),
      snapshot: JSON.stringify([{ id: composerAdvisory.id }]),
      checksum: "legacy",
      schemaVersion,
    })
    const calls: string[] = []
    const result = await queryOsvWithCache([composerPackage], {
      cache,
      fetchFn: async (url) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify(
            String(url).endsWith("/querybatch")
              ? { results: [{ vulns: [{ id: composerAdvisory.id }] }] }
              : composerAdvisory
          )
        )
      },
    })
    expect(result.status).toBe("COMPLETE")
    expect(result.results[0]?.vulns[0]).toMatchObject(composerAdvisory)
    expect(calls).toHaveLength(2)
  }
)

it.each(["osv-querybatch/1", "osv-querybatch/2"])(
  "refetches a legacy empty %s cache",
  async (schemaVersion) => {
    const cache = new InMemoryAdvisoryCache()
    await cache.set({
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      version: pkg.version,
      vulns: [],
      source: "osv",
      fetchedAt: new Date(),
      snapshot: "[]",
      checksum: "legacy",
      schemaVersion,
    })
    let calls = 0
    const result = await queryOsvWithCache([pkg], {
      cache,
      fetchFn: async () => {
        calls++
        return new Response(JSON.stringify({ results: [{}] }))
      },
    })
    expect(result.status).toBe("COMPLETE")
    expect(calls).toBe(1)
  }
)

it("chunks 250 exact releases into <=100 requests with concurrency two", async () => {
  let active = 0
  let peak = 0
  const sizes: number[] = []
  const result = await queryOsvWithCache(
    Array.from({ length: 250 }, (_, i) => ({ ...pkg, name: `pkg${i}` })),
    {
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async (_url, init) => {
        const queries = JSON.parse(String(init?.body)).queries as unknown[]
        sizes.push(queries.length)
        peak = Math.max(peak, ++active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return new Response(JSON.stringify({ results: queries.map(() => ({})) }))
      },
    }
  )
  expect(result).toMatchObject({ status: "COMPLETE", requestedCount: 250, resolvedCount: 250 })
  expect(sizes).toEqual([100, 100, 50])
  expect(peak).toBe(2)
})

it("retries a transient batch twice then records partial coverage while caching successful chunks", async () => {
  const cache = new InMemoryAdvisoryCache()
  let failedAttempts = 0
  const packages = Array.from({ length: 101 }, (_, i) => ({ ...pkg, name: `pkg${i}` }))
  const result = await queryOsvWithCache(packages, {
    cache,
    fetchFn: async (_url, init) => {
      const queries = JSON.parse(String(init?.body)).queries as Array<{ package: { name: string } }>
      if (queries[0]?.package.name === "pkg100") {
        failedAttempts++
        return new Response("busy", { status: 503, headers: { "retry-after": "0" } })
      }
      return new Response(JSON.stringify({ results: queries.map(() => ({})) }))
    },
  })
  expect(failedAttempts).toBe(3)
  expect(result).toMatchObject({
    status: "PARTIAL",
    requestedCount: 101,
    resolvedCount: 100,
    snapshotChecksum: null,
  })
  expect(result.unresolved).toEqual([expect.objectContaining({ name: "pkg100" })])
  expect(await cache.get("npm", "pkg0", "1.2.3")).toBeDefined()
  expect(await cache.get("npm", "pkg100", "1.2.3")).toBeUndefined()
})

it("recovers on a transient retry and does not retry permanent or malformed responses", async () => {
  let attempts = 0
  const result = await queryOsvWithCache([pkg], {
    cache: new InMemoryAdvisoryCache(),
    fetchFn: async () =>
      ++attempts === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ results: [{}] })),
  })
  expect(result.status).toBe("COMPLETE")
  expect(attempts).toBe(2)
  for (const response of [
    () => new Response("bad", { status: 400 }),
    () => new Response(JSON.stringify({ results: [] })),
  ]) {
    let calls = 0
    const unavailable = await queryOsvWithCache([pkg], {
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async () => {
        calls++
        return response()
      },
    })
    expect(unavailable.status).toBe("UNAVAILABLE")
    expect(calls).toBe(1)
  }
})

it.each(["invalid", [], null, 5].map((row) => [row]))(
  "never caches a malformed package result %j as clean",
  async (row) => {
    const cache = new InMemoryAdvisoryCache()
    const result = await queryOsvWithCache([pkg], {
      cache,
      fetchFn: async () => new Response(JSON.stringify({ results: [row] })),
    })
    expect(result.status).toBe("UNAVAILABLE")
    expect(await cache.get("npm", pkg.name, pkg.version)).toBeUndefined()
  }
)

it("shares the original deadline with later chunks and preserves completed package results", async () => {
  vi.useFakeTimers()
  const signals = new Set<AbortSignal | null | undefined>()
  const resultPromise = queryOsvWithCache(
    Array.from({ length: 201 }, (_, i) => ({ ...pkg, name: `pkg${i}` })),
    {
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async (_url, init) => {
        signals.add(init?.signal)
        const queries = JSON.parse(String(init?.body)).queries as unknown[]
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 14_000)
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(new DOMException("aborted", "AbortError"))
            },
            { once: true }
          )
        })
        return new Response(JSON.stringify({ results: queries.map(() => ({})) }))
      },
    }
  )
  await vi.advanceTimersByTimeAsync(15_000)
  const result = await resultPromise
  expect(signals.size).toBe(1)
  expect(result).toMatchObject({
    status: "PARTIAL",
    requestedCount: 201,
    resolvedCount: 200,
    snapshotChecksum: null,
  })
  expect(result.unresolved).toEqual([
    expect.objectContaining({ name: "pkg200", reason: expect.stringMatching(/timed out/) }),
  ])
})

it("bounds Retry-After and cancels before another retry", async () => {
  vi.useFakeTimers()
  let calls = 0
  const controller = new AbortController()
  const resultPromise = queryOsvWithCache([pkg], {
    signal: controller.signal,
    cache: new InMemoryAdvisoryCache(),
    fetchFn: async () => {
      calls++
      return new Response("busy", { status: 429, headers: { "retry-after": "9999999" } })
    },
  })
  await vi.advanceTimersByTimeAsync(999)
  expect(calls).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(calls).toBe(2)
  controller.abort()
  const result = await resultPromise
  expect(result.status).toBe("UNAVAILABLE")
  expect(calls).toBe(2)
})

it("does not publish the first unrelated fixed event as a cached upgrade recommendation", async () => {
  const cache = new InMemoryAdvisoryCache()
  const result = await queryOsvWithCache([composerPackage], {
    cache,
    fetchFn: async () => new Response(JSON.stringify({ results: [{ vulns: [composerAdvisory] }] })),
  })
  expect(result.status).toBe("COMPLETE")
  expect(
    (await cache.get("Packagist", composerPackage.name, composerPackage.version))?.vulns[0]?.fixed
  ).toBeUndefined()
})

it("keeps streamed advisory response bodies within the same two-request concurrency budget", async () => {
  let active = 0
  let peak = 0
  const result = await queryOsvWithCache([pkg], {
    cache: new InMemoryAdvisoryCache(),
    fetchFn: async (url) => {
      if (String(url).endsWith("/querybatch"))
        return new Response(
          JSON.stringify({ results: [{ vulns: ["A", "B", "C", "D"].map((id) => ({ id })) }] })
        )
      peak = Math.max(peak, ++active)
      const id = String(url).split("/").at(-1)
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              active--
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ id, affected: [] })))
              controller.close()
            }, 5)
          },
        })
      )
    },
  })
  expect(result.status).toBe("COMPLETE")
  expect(peak).toBe(2)
})

it("does not retry or cache an oversized inline batch response", async () => {
  const cache = new InMemoryAdvisoryCache()
  let calls = 0
  const result = await queryOsvWithCache([pkg], {
    cache,
    fetchFn: async () => {
      calls++
      return new Response(
        JSON.stringify({
          results: [
            { vulns: [{ id: "GHSA-large", affected: [], details: "x".repeat(2 * 1024 * 1024) }] },
          ],
        })
      )
    },
  })
  expect(result.status).toBe("UNAVAILABLE")
  expect(calls).toBe(1)
  expect(await cache.get("npm", pkg.name, pkg.version)).toBeUndefined()
})

it("shares the existing 200-detail request ceiling across chunks and preserves unresolved candidate IDs", async () => {
  let detailRequests = 0
  const result = await queryOsvWithCache(
    Array.from({ length: 201 }, (_, i) => ({ ...pkg, name: `pkg${i}` })),
    {
      cache: new InMemoryAdvisoryCache(),
      fetchFn: async (url, init) => {
        if (String(url).endsWith("/querybatch")) {
          const queries = JSON.parse(String(init?.body)).queries as Array<{
            package: { name: string }
          }>
          return new Response(
            JSON.stringify({
              results: queries.map((query) => ({ vulns: [{ id: `GHSA-${query.package.name}` }] })),
            })
          )
        }
        detailRequests++
        return new Response(JSON.stringify({ id: String(url).split("/").at(-1), affected: [] }))
      },
    }
  )
  expect(detailRequests).toBe(200)
  expect(result.status).toBe("PARTIAL")
  expect(result.snapshotChecksum).toBeNull()
  expect(result.results.find((row) => row.package.name === "pkg200")?.vulns).toEqual([
    { id: "GHSA-pkg200" },
  ])
})
