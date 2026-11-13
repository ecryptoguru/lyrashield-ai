import { beforeEach, describe, expect, it, vi } from "vitest"
const database = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }))
vi.mock("./client", () => ({ prisma: { advisoryCacheEntry: database } }))
import {
  InMemoryAdvisoryCache,
  PostgresAdvisoryCache,
  type AdvisoryEntry,
  type AdvisoryEcosystem,
} from "./advisory-cache-service"
import { queryOsvWithCache } from "./osv-client"
import { OSV_CACHE_SCHEMA_VERSION } from "./osv-details"
beforeEach(() => vi.resetAllMocks())
const entry = (ecosystem: AdvisoryEcosystem, name: string): AdvisoryEntry => ({
  ecosystem,
  name,
  version: "1.2.3",
  vulns: [],
  source: "osv",
  fetchedAt: new Date(),
  snapshot: "[]",
  checksum: "a".repeat(64),
  schemaVersion: OSV_CACHE_SCHEMA_VERSION,
})
describe("source-bound advisory package identity", () => {
  for (const ecosystem of ["Go", "RubyGems"] as const) {
    it(`keeps ${ecosystem} case variants distinct in requests, receipts and memory cache`, async () => {
      const names =
        ecosystem === "Go" ? ["example.org/Widget", "example.org/widget"] : ["Rack", "rack"]
      const requests: string[] = []
      const result = await queryOsvWithCache(
        names.map((name) => ({ ecosystem, name, version: "1.2.3", filePath: "lock" })),
        {
          cache: new InMemoryAdvisoryCache(),
          fetchFn: async (_url, init) => {
            const query = JSON.parse(String(init?.body))
            requests.push(
              ...query.queries.map((q: { package: { name: string } }) => q.package.name)
            )
            return new Response(JSON.stringify({ results: query.queries.map(() => ({})) }), {
              status: 200,
            })
          },
        }
      )
      expect(requests).toEqual(names)
      expect(result.requestedCount).toBe(2)
      const fetchFn = async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 })
      const upper = await queryOsvWithCache(
        [{ ecosystem, name: names[0]!, version: "1.2.3", filePath: "lock" }],
        { cache: new InMemoryAdvisoryCache(), fetchFn }
      )
      const lower = await queryOsvWithCache(
        [{ ecosystem, name: names[1]!, version: "1.2.3", filePath: "lock" }],
        { cache: new InMemoryAdvisoryCache(), fetchFn }
      )
      expect(upper.snapshotChecksum).not.toBe(lower.snapshotChecksum)
      const memory = new InMemoryAdvisoryCache()
      await memory.set(entry(ecosystem, names[0]!))
      expect(await memory.get(ecosystem, names[1]!, "1.2.3")).toBeUndefined()
    })
    it(`uses distinct ${ecosystem} PostgreSQL get/set keys`, async () => {
      const cache = new PostgresAdvisoryCache()
      await cache.set(entry(ecosystem, "Widget"))
      expect(database.upsert.mock.calls[0]?.[0]).toMatchObject({
        where: {
          ecosystem_normalizedName_version_source_schemaVersion: {
            normalizedName: "Widget",
            schemaVersion: OSV_CACHE_SCHEMA_VERSION,
          },
        },
        create: { normalizedName: "Widget" },
      })
      await cache.get(ecosystem, "Widget", "1.2.3")
      await cache.get(ecosystem, "widget", "1.2.3")
      expect(
        database.findUnique.mock.calls.map(
          (call) =>
            call[0].where.ecosystem_normalizedName_version_source_schemaVersion.normalizedName
        )
      ).toEqual(["Widget", "widget"])
    })
  }
  it("retains canonical npm/PyPI/Packagist cache semantics", async () => {
    const cache = new PostgresAdvisoryCache()
    for (const ecosystem of ["npm", "PyPI", "Packagist"] as const) {
      await cache.set(entry(ecosystem, " Example "))
      await cache.get(ecosystem, "EXAMPLE", "1.2.3")
    }
    expect(
      database.upsert.mock.calls.every((call) => call[0].create.normalizedName === "example")
    ).toBe(true)
    expect(
      database.findUnique.mock.calls.every(
        (call) =>
          call[0].where.ecosystem_normalizedName_version_source_schemaVersion.normalizedName ===
          "example"
      )
    ).toBe(true)
  })
  it("uses a new schema namespace without modifying historical cache rows", async () => {
    expect(OSV_CACHE_SCHEMA_VERSION).toBe("osv-querybatch/4")
    const cache = new PostgresAdvisoryCache()
    await cache.get("Go", "example.org/Widget", "1.2.3")
    expect(
      database.findUnique.mock.calls[0]?.[0].where
        .ecosystem_normalizedName_version_source_schemaVersion.schemaVersion
    ).toBe("osv-querybatch/4")
    expect(database.upsert).not.toHaveBeenCalled()
    const memory = new InMemoryAdvisoryCache()
    await memory.set({ ...entry("Go", "example.org/Widget"), schemaVersion: "osv-querybatch/3" })
    expect(await memory.get("Go", "example.org/Widget", "1.2.3")).toBeUndefined()
  })
})
