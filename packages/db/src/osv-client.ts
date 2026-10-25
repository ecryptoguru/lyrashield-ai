import {
  OSV_CACHE_SCHEMA_VERSION,
  hydrateOsvDetails,
  hasOsvDetails,
  OsvVulnerabilitySchema,
  type OsvVulnerability,
} from "./osv-details"
import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import {
  getAdvisoryCache,
  type AdvisoryCache,
  type AdvisoryEcosystem,
  type AdvisoryEntry,
} from "./advisory-cache-service"

export interface OsvQueryPackage {
  name: string
  version: string
  ecosystem: AdvisoryEcosystem
  filePath: string
}

export type { OsvVulnerability } from "./osv-details"

export interface OsvQueryResult {
  package: OsvQueryPackage
  vulns: OsvVulnerability[]
}

export interface AdvisoryBatchResult {
  status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
  source: "OSV"
  requestedCount: number
  resolvedCount: number
  results: OsvQueryResult[]
  fetchedAt: string | null
  snapshotId: string | null
  snapshotChecksum: string | null
  cacheAgeSeconds: number | null
  supportedEcosystems: string[]
  unresolved: Array<{ ecosystem: string; name: string; reason: string }>
}

export interface OsvQueryOptions {
  fetchFn?: typeof fetch
  now?: Date
  /**
   * Optional cache instance. Tests pass a dedicated cache to avoid the
   * module-global advisory cache racing across parallel test files; production
   * callers omit this and use the global cache via getAdvisoryCache().
   */
  cache?: AdvisoryCache
}

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch"
const OSV_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SCHEMA_VERSION = OSV_CACHE_SCHEMA_VERSION

function ecosystemToOsv(ecosystem: AdvisoryEcosystem): string {
  return ecosystem
}

function packageKey(pkg: OsvQueryPackage): string {
  return `${pkg.ecosystem}:${pkg.name.trim().toLowerCase()}@${pkg.version}`
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function toAdvisoryEntry(
  pkg: OsvQueryPackage,
  vulns: OsvVulnerability[],
  fetchedAt: Date
): AdvisoryEntry {
  return {
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    version: pkg.version,
    vulns: vulns.map((v) => ({
      id: v.id,
      summary: v.summary,
      severity: v.database_specific?.severity ?? v.severity?.[0]?.score ?? "unknown",
      fixed: v.affected
        ?.flatMap((a) => a.ranges?.flatMap((r) => r.events) ?? [])
        .find((event) => event.fixed)?.fixed,
    })),
    source: "osv",
    fetchedAt,
    snapshot: JSON.stringify(vulns),
    checksum: checksum(vulns),
    schemaVersion: SCHEMA_VERSION,
  }
}

function unavailable(
  packages: OsvQueryPackage[],
  results: OsvQueryResult[],
  unresolved: AdvisoryBatchResult["unresolved"],
  now: Date
): AdvisoryBatchResult {
  const status = results.length === 0 ? "UNAVAILABLE" : "PARTIAL"
  return {
    status,
    source: "OSV",
    requestedCount: packages.length,
    resolvedCount: results.length,
    results,
    fetchedAt: results.length > 0 ? now.toISOString() : null,
    snapshotId: null,
    snapshotChecksum: null,
    cacheAgeSeconds: null,
    supportedEcosystems: [...new Set(packages.map((pkg) => pkg.ecosystem))],
    unresolved,
  }
}

async function resolveFreshOsvResults(
  rows: Array<{ vulns?: OsvVulnerability[]; next_page_token?: unknown }>,
  packages: OsvQueryPackage[],
  fetchFn: typeof fetch,
  signal: AbortSignal
): Promise<{ results: OsvQueryResult[]; reason?: string }> {
  const results: OsvQueryResult[] = []
  for (const [index, pkg] of packages.entries()) {
    const row = rows[index]
    if (!row || (row.vulns !== undefined && !Array.isArray(row.vulns)))
      return { results: [], reason: "OSV returned malformed advisory data" }
    results.push({ package: pkg, vulns: row.vulns ?? [] })
  }
  const hydrated = await hydrateOsvDetails(
    results.flatMap((result) => result.vulns),
    fetchFn,
    signal
  )
  const byId = new Map(hydrated.vulns.map((vulnerability) => [vulnerability.id, vulnerability]))
  for (const result of results)
    result.vulns = result.vulns.flatMap((vulnerability) => {
      const detail = byId.get(vulnerability?.id)
      return detail ? [detail] : []
    })
  const paginated = rows.some(
    (row) => row.next_page_token !== undefined && row.next_page_token !== ""
  )
  return {
    results,
    ...(hydrated.incomplete || paginated
      ? {
          reason: paginated
            ? "OSV pagination requires additional advisory coverage"
            : "OSV advisory details unavailable or exceeded validation limits",
        }
      : {}),
  }
}

async function readCachedOsvResults(unique: OsvQueryPackage[], cache: AdvisoryCache, now: Date) {
  const results: OsvQueryResult[] = []
  const uncached: OsvQueryPackage[] = []
  let oldestFreshCache: Date | undefined

  for (const pkg of unique) {
    try {
      const cached = await cache.get(pkg.ecosystem, pkg.name, pkg.version)
      if (
        !cached ||
        cached.schemaVersion !== SCHEMA_VERSION ||
        now.getTime() - cached.fetchedAt.getTime() >= CACHE_TTL_MS
      ) {
        uncached.push(pkg)
        continue
      }
      const vulns = JSON.parse(cached.snapshot) as OsvVulnerability[]
      if (
        !Array.isArray(vulns) ||
        !vulns.every((value) => {
          const parsed = OsvVulnerabilitySchema.safeParse(value)
          return parsed.success && hasOsvDetails(parsed.data)
        })
      ) {
        uncached.push(pkg)
        continue
      }
      oldestFreshCache =
        !oldestFreshCache || cached.fetchedAt < oldestFreshCache
          ? cached.fetchedAt
          : oldestFreshCache
      results.push({ package: pkg, vulns })
    } catch (error) {
      logger.warn("OSV cache entry could not be read", {
        error: error instanceof Error ? error.message : String(error),
      })
      uncached.push(pkg)
    }
  }

  return { results, uncached, oldestFreshCache }
}

/**
 * Queries exact resolved releases only. Transport or response failures are
 * represented explicitly so callers can never treat an outage as a clean scan.
 */
export async function queryOsvWithCache(
  packages: OsvQueryPackage[],
  options: OsvQueryOptions = {}
): Promise<AdvisoryBatchResult> {
  const now = options.now ?? new Date()
  const unique = [...new Map(packages.map((pkg) => [packageKey(pkg), pkg])).values()]
  if (unique.length === 0) {
    return {
      status: "COMPLETE",
      source: "OSV",
      requestedCount: 0,
      resolvedCount: 0,
      results: [],
      fetchedAt: now.toISOString(),
      snapshotId: checksum([]),
      snapshotChecksum: checksum([]),
      cacheAgeSeconds: 0,
      supportedEcosystems: [],
      unresolved: [],
    }
  }

  const cache = options.cache ?? getAdvisoryCache()
  const { results, uncached, oldestFreshCache } = await readCachedOsvResults(unique, cache, now)

  if (uncached.length > 0) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OSV_TIMEOUT_MS)
    try {
      const response = await (options.fetchFn ?? fetch)(OSV_BATCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: uncached.map((pkg) => ({
            package: { name: pkg.name, ecosystem: ecosystemToOsv(pkg.ecosystem) },
            version: pkg.version,
          })),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        return unavailable(
          unique,
          results,
          uncached.map((pkg) => ({
            ecosystem: pkg.ecosystem,
            name: pkg.name,
            reason: `OSV returned HTTP ${response.status}`,
          })),
          now
        )
      }
      const data = (await response.json()) as {
        results?: Array<{ vulns?: OsvVulnerability[]; next_page_token?: unknown }>
      }
      if (!Array.isArray(data.results) || data.results.length !== uncached.length) {
        return unavailable(
          unique,
          results,
          uncached.map((pkg) => ({
            ecosystem: pkg.ecosystem,
            name: pkg.name,
            reason: "OSV returned an incomplete batch",
          })),
          now
        )
      }
      const fresh = await resolveFreshOsvResults(
        data.results,
        uncached,
        options.fetchFn ?? fetch,
        controller.signal
      )
      if (fresh.reason)
        return unavailable(
          unique,
          [...results, ...fresh.results],
          uncached.map((pkg) => ({
            ecosystem: pkg.ecosystem,
            name: pkg.name,
            reason: fresh.reason!,
          })),
          now
        )
      const freshResults = fresh.results
      // Cache only a verified complete response; an individual cache write is
      // non-authoritative and does not change the just-received OSV result.
      await Promise.all(
        freshResults.map((result) =>
          cache.set(toAdvisoryEntry(result.package, result.vulns, now)).catch((error) => {
            logger.warn("OSV response cache write failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        )
      )
      results.push(...freshResults)
    } catch (error) {
      return unavailable(
        unique,
        results,
        uncached.map((pkg) => ({
          ecosystem: pkg.ecosystem,
          name: pkg.name,
          reason:
            error instanceof Error && error.name === "AbortError"
              ? "OSV request timed out"
              : "OSV request failed",
        })),
        now
      )
    } finally {
      clearTimeout(timer)
    }
  }

  const ordered = results.sort((a, b) => packageKey(a.package).localeCompare(packageKey(b.package)))
  const snapshotChecksum = checksum(
    ordered.map(({ package: pkg, vulns }) => ({
      ecosystem: pkg.ecosystem,
      name: pkg.name.trim().toLowerCase(),
      version: pkg.version,
      vulns,
    }))
  )
  return {
    status: "COMPLETE",
    source: "OSV",
    requestedCount: unique.length,
    resolvedCount: ordered.length,
    results: ordered,
    fetchedAt: now.toISOString(),
    snapshotId: snapshotChecksum,
    snapshotChecksum,
    cacheAgeSeconds: oldestFreshCache
      ? Math.floor((now.getTime() - oldestFreshCache.getTime()) / 1000)
      : 0,
    supportedEcosystems: [...new Set(unique.map((pkg) => pkg.ecosystem))],
    unresolved: [],
  }
}
