import { createHash } from "node:crypto"
import { logger } from "@lyrashield/logger"
import {
  getAdvisoryCache,
  type AdvisoryEcosystem,
  type AdvisoryEntry,
} from "./advisory-cache-service"

export interface OsvQueryPackage {
  name: string
  version: string
  ecosystem: AdvisoryEcosystem
  filePath: string
}

export interface OsvVulnerability {
  id: string
  summary?: string
  details?: string
  severity?: Array<{ type: string; score: string }>
  aliases?: string[]
  references?: Array<{ url: string }>
  affected?: Array<{
    package?: { name: string; ecosystem: string }
    ranges?: Array<{
      type: string
      events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>
    }>
  }>
  database_specific?: { severity?: string; cvss?: { vectorString?: string } }
}

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
}

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch"
const OSV_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SCHEMA_VERSION = "osv-querybatch/1"

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

  const cache = getAdvisoryCache()
  const results: OsvQueryResult[] = []
  const uncached: OsvQueryPackage[] = []
  let oldestFreshCache: Date | undefined

  for (const pkg of unique) {
    try {
      const cached = await cache.get(pkg.ecosystem, pkg.name, pkg.version)
      if (!cached || now.getTime() - cached.fetchedAt.getTime() >= CACHE_TTL_MS) {
        uncached.push(pkg)
        continue
      }
      const vulns = JSON.parse(cached.snapshot) as OsvVulnerability[]
      if (!Array.isArray(vulns)) {
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
      const data = (await response.json()) as { results?: Array<{ vulns?: OsvVulnerability[] }> }
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
      const freshResults: OsvQueryResult[] = []
      for (const [index, pkg] of uncached.entries()) {
        const row = data.results[index]
        if (!row || (row.vulns !== undefined && !Array.isArray(row.vulns))) {
          return unavailable(
            unique,
            results,
            uncached.map((candidate) => ({
              ecosystem: candidate.ecosystem,
              name: candidate.name,
              reason: "OSV returned malformed advisory data",
            })),
            now
          )
        }
        freshResults.push({ package: pkg, vulns: row.vulns ?? [] })
      }
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
