import { afterEach, describe, expect, it } from "vitest"
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

afterEach(() => setAdvisoryCache(new InMemoryAdvisoryCache()))

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

it("refreshes a fresh legacy cache containing ID-only advisories", async () => {
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
    schemaVersion: "osv-querybatch/1",
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
})

it("refetches a legacy empty cache because older batches did not track pagination", async () => {
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
    schemaVersion: "osv-querybatch/1",
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
})
