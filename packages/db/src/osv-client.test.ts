import { afterEach, describe, expect, it } from "vitest"
import { InMemoryAdvisoryCache, setAdvisoryCache } from "./advisory-cache-service"
import { queryOsvWithCache, type OsvQueryPackage } from "./osv-client"

const pkg: OsvQueryPackage = {
  ecosystem: "npm",
  name: "example",
  version: "1.2.3",
  filePath: "package-lock.json",
}
const now = new Date("2026-08-14T00:00:00.000Z")

afterEach(() => setAdvisoryCache(new InMemoryAdvisoryCache()))

describe("queryOsvWithCache", () => {
  it("returns a complete fresh receipt for a clean exact package", async () => {
    setAdvisoryCache(new InMemoryAdvisoryCache())
    const result = await queryOsvWithCache([pkg], {
      now,
      fetchFn: async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
    })

    expect(result).toMatchObject({ status: "COMPLETE", resolvedCount: 1, requestedCount: 1 })
    expect(result.results[0]?.vulns).toEqual([])
    expect(result.snapshotChecksum).toHaveLength(64)
  })

  it("does not turn an outage or malformed partial batch into a clean result", async () => {
    setAdvisoryCache(new InMemoryAdvisoryCache())
    const unavailable = await queryOsvWithCache([pkg], {
      now,
      fetchFn: async () => new Response("down", { status: 503 }),
    })
    const malformed = await queryOsvWithCache([pkg], {
      now,
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
    setAdvisoryCache(cache)
    const first = await queryOsvWithCache([pkg], {
      now,
      fetchFn: async () =>
        new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-test" }] }] }), {
          status: 200,
        }),
    })
    const second = await queryOsvWithCache([pkg], {
      now: new Date(now.getTime() + 1_000),
      fetchFn: async () => {
        throw new Error("network should not be used")
      },
    })

    expect(second.status).toBe("COMPLETE")
    expect(second.snapshotChecksum).toBe(first.snapshotChecksum)
  })
})
