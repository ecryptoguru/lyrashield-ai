import { logger } from "@lyrashield/logger"

const CISA_KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
const FIRST_EPSS_URL = "https://api.first.org/data/v1/epss"
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/
const MAX_CVES = 200
const EPSS_BATCH_SIZE = 50
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const KEV_CACHE_MS = 30 * 60 * 1000

export interface ThreatSignal {
  knownExploited?: true
  dateAdded?: string
  dueDate?: string
  knownRansomwareCampaignUse?: string
  epss?: number
  percentile?: number
  epssDate?: string
}

type KevEntry = {
  cveID?: unknown
  dateAdded?: unknown
  dueDate?: unknown
  knownRansomwareCampaignUse?: unknown
}

let kevCache: { expiresAt: number; entries: Map<string, ThreatSignal> } | null = null

export function clearThreatIntelligenceCache(): void {
  kevCache = null
}

async function fetchJson(
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("response exceeded size limit")
    }
    const body = await response.text()
    if (body.length > MAX_RESPONSE_BYTES) throw new Error("response exceeded size limit")
    return JSON.parse(body) as unknown
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

async function loadKev(fetchFn: typeof fetch, signal?: AbortSignal) {
  if (kevCache && kevCache.expiresAt > Date.now()) return kevCache.entries
  try {
    const payload = (await fetchJson(CISA_KEV_URL, fetchFn, signal)) as {
      vulnerabilities?: KevEntry[]
    }
    const entries = new Map<string, ThreatSignal>()
    for (const item of payload.vulnerabilities ?? []) {
      const cve = typeof item.cveID === "string" ? item.cveID.toUpperCase() : ""
      if (!CVE_PATTERN.test(cve)) continue
      entries.set(cve, {
        knownExploited: true,
        ...(typeof item.dateAdded === "string" ? { dateAdded: item.dateAdded } : {}),
        ...(typeof item.dueDate === "string" ? { dueDate: item.dueDate } : {}),
        ...(typeof item.knownRansomwareCampaignUse === "string"
          ? { knownRansomwareCampaignUse: item.knownRansomwareCampaignUse }
          : {}),
      })
    }
    kevCache = { expiresAt: Date.now() + KEV_CACHE_MS, entries }
    return entries
  } catch (error) {
    if (signal?.aborted) throw new Error("SCA scan cancelled")
    logger.warn("CISA KEV enrichment failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Map<string, ThreatSignal>()
  }
}

async function loadEpss(cves: string[], fetchFn: typeof fetch, signal?: AbortSignal) {
  const entries = new Map<string, ThreatSignal>()
  for (let start = 0; start < cves.length; start += EPSS_BATCH_SIZE) {
    const batch = cves.slice(start, start + EPSS_BATCH_SIZE)
    try {
      const payload = (await fetchJson(
        `${FIRST_EPSS_URL}?cve=${encodeURIComponent(batch.join(","))}`,
        fetchFn,
        signal
      )) as {
        data?: Array<{ cve?: unknown; epss?: unknown; percentile?: unknown; date?: unknown }>
      }
      for (const item of payload.data ?? []) {
        const cve = typeof item.cve === "string" ? item.cve.toUpperCase() : ""
        const epss = typeof item.epss === "string" ? Number(item.epss) : item.epss
        const percentile =
          typeof item.percentile === "string" ? Number(item.percentile) : item.percentile
        if (!CVE_PATTERN.test(cve)) continue
        entries.set(cve, {
          ...(typeof epss === "number" && Number.isFinite(epss) && epss >= 0 && epss <= 1
            ? { epss }
            : {}),
          ...(typeof percentile === "number" &&
          Number.isFinite(percentile) &&
          percentile >= 0 &&
          percentile <= 1
            ? { percentile }
            : {}),
          ...(typeof item.date === "string" ? { epssDate: item.date } : {}),
        })
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("SCA scan cancelled")
      logger.warn("FIRST EPSS enrichment failed", {
        error: error instanceof Error ? error.message : String(error),
        cveCount: batch.length,
      })
    }
  }
  return entries
}

export async function fetchThreatSignals(
  cveIds: readonly string[],
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<Map<string, ThreatSignal>> {
  const cves = [
    ...new Set(cveIds.map((cve) => cve.toUpperCase()).filter((cve) => CVE_PATTERN.test(cve))),
  ].slice(0, MAX_CVES)
  if (cves.length === 0) return new Map()

  const [kev, epss] = await Promise.all([loadKev(fetchFn, signal), loadEpss(cves, fetchFn, signal)])
  return new Map(
    cves.flatMap((cve) => {
      const combined = { ...kev.get(cve), ...epss.get(cve) }
      return Object.keys(combined).length > 0 ? [[cve, combined] as const] : []
    })
  )
}
