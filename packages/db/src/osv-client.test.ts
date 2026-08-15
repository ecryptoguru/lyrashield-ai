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
        new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-test" }] }] }), {
          status: 200,
        }),
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
