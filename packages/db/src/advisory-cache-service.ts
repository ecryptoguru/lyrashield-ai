import { logger } from "@lyrashield/logger"
import { prisma } from "./client"

export type AdvisoryEcosystem =
  "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems" | "Packagist" | "Maven"

export type AdvisoryEntry = {
  ecosystem: AdvisoryEcosystem
  name: string
  version: string
  vulns: Array<{
    id: string
    summary?: string
    severity?: string
    fixed?: string
  }>
  source: "osv"
  fetchedAt: Date
  snapshot: string
  checksum: string
  schemaVersion: string
}

export interface AdvisoryCache {
  get(
    ecosystem: AdvisoryEcosystem,
    name: string,
    version: string
  ): Promise<AdvisoryEntry | undefined>
  set(entry: AdvisoryEntry): Promise<void>
}

const TTL_MS = 24 * 60 * 60 * 1000

export class InMemoryAdvisoryCache implements AdvisoryCache {
  private readonly store = new Map<string, AdvisoryEntry>()

  private key(ecosystem: AdvisoryEcosystem, name: string, version: string): string {
    return `${ecosystem}:${name}:${version}`
  }

  async get(
    ecosystem: AdvisoryEcosystem,
    name: string,
    version: string
  ): Promise<AdvisoryEntry | undefined> {
    const entry = this.store.get(this.key(ecosystem, name, version))
    if (!entry) return undefined
    if (Date.now() - entry.fetchedAt.getTime() > TTL_MS) {
      this.store.delete(this.key(ecosystem, name, version))
      return undefined
    }
    return entry
  }

  async set(entry: AdvisoryEntry): Promise<void> {
    this.store.set(this.key(entry.ecosystem, entry.name, entry.version), entry)
  }
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

/** PostgreSQL-backed default; the in-memory implementation is test-only. */
export class PostgresAdvisoryCache implements AdvisoryCache {
  async get(
    ecosystem: AdvisoryEcosystem,
    name: string,
    version: string
  ): Promise<AdvisoryEntry | undefined> {
    const entry = await prisma.advisoryCacheEntry.findUnique({
      where: {
        ecosystem_normalizedName_version_source_schemaVersion: {
          ecosystem,
          normalizedName: normalizedName(name),
          version,
          source: "osv",
          schemaVersion: "osv-querybatch/1",
        },
      },
    })
    if (!entry) return undefined
    return {
      ecosystem,
      name,
      version,
      vulns: [],
      source: "osv",
      fetchedAt: entry.fetchedAt,
      snapshot: JSON.stringify(entry.snapshot),
      checksum: entry.checksum,
      schemaVersion: entry.schemaVersion,
    }
  }

  async set(entry: AdvisoryEntry): Promise<void> {
    await prisma.advisoryCacheEntry.upsert({
      where: {
        ecosystem_normalizedName_version_source_schemaVersion: {
          ecosystem: entry.ecosystem,
          normalizedName: normalizedName(entry.name),
          version: entry.version,
          source: entry.source,
          schemaVersion: entry.schemaVersion,
        },
      },
      create: {
        ecosystem: entry.ecosystem,
        normalizedName: normalizedName(entry.name),
        version: entry.version,
        source: entry.source,
        schemaVersion: entry.schemaVersion,
        snapshot: JSON.parse(entry.snapshot),
        checksum: entry.checksum,
        fetchedAt: entry.fetchedAt,
        expiresAt: new Date(entry.fetchedAt.getTime() + TTL_MS),
      },
      update: {
        snapshot: JSON.parse(entry.snapshot),
        checksum: entry.checksum,
        fetchedAt: entry.fetchedAt,
        expiresAt: new Date(entry.fetchedAt.getTime() + TTL_MS),
      },
    })
  }
}

let globalCache: AdvisoryCache | undefined

export function getAdvisoryCache(): AdvisoryCache {
  if (!globalCache) {
    globalCache = new PostgresAdvisoryCache()
    logger.info("Advisory cache initialized", { backend: "postgres" })
  }
  return globalCache
}

export function setAdvisoryCache(cache: AdvisoryCache): void {
  globalCache = cache
}
