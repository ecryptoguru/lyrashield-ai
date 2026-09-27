import type { SortMode } from "@/app/(dashboard)/dashboard/findings/findings-client"

/**
 * Server-parsed findings-list state.
 *
 * The filter/sort/search state must be parsed on the server and passed into
 * the client component as initial props. Reading `window.location.search`
 * inside a useState initializer renders different first trees on server and
 * client (server sees no URL, the browser sees `?filter=…`), which is the
 * hydration divergence behind React error #418 on authenticated routes — and
 * once hydration diverges, streamed Suspense boundary completion crashes with
 * the `$RS`/`parentNode` TypeError.
 *
 * URL contract: no `filter` parameter means Open. Choosing All must write
 * `filter=ALL` explicitly — the parameter is never removed, because absence
 * now carries meaning.
 */

const FINDING_FILTERS = [
  "ALL",
  "OPEN",
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
  "FIXED",
  "VERIFIED",
] as const

export type FindingFilter = (typeof FINDING_FILTERS)[number]

const FINDING_SORTS = ["priority", "severity", "newest"] as const

const DEFAULT_FINDING_FILTER: FindingFilter = "OPEN"

interface FindingListParams {
  filter: FindingFilter
  sort: SortMode
  scanId: string
  target: string
  scopeValid: boolean
  q: string
}

export function parseFindingListParams(params: {
  filter?: string
  sort?: string
  scanId?: string
  target?: string
  targetId?: string
  q?: string
}): FindingListParams {
  const filter = (FINDING_FILTERS as readonly string[]).includes(params.filter ?? "")
    ? (params.filter as FindingFilter)
    : DEFAULT_FINDING_FILTER
  const sort = (FINDING_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as SortMode)
    : "priority"
  const scanId = params.scanId?.trim() ?? ""
  const target = params.target?.trim() ?? ""
  const targetId = params.targetId?.trim() ?? ""
  return {
    filter,
    sort,
    scanId,
    target: target || targetId,
    scopeValid:
      (params.scanId === undefined || Boolean(scanId)) &&
      (params.target === undefined || Boolean(target)) &&
      (params.targetId === undefined || Boolean(targetId)) &&
      !(target && targetId && target !== targetId),
    q: params.q?.trim().slice(0, 120) ?? "",
  }
}

export function findingsHref(params: {
  tab?: string
  finding?: string
  scanId?: string
  target?: string
  targetId?: string
}): string {
  const query = new URLSearchParams()
  for (const key of ["tab", "finding", "scanId", "target", "targetId"] as const) {
    const value = params[key]
    if (value !== undefined) query.set(key, value)
  }
  return `/dashboard/findings?${query.toString()}`
}

export function reportsHref(params: { scanId?: string; targetId?: string }): string {
  const query = new URLSearchParams()
  if (params.scanId !== undefined) query.set("scanId", params.scanId)
  if (params.targetId !== undefined) query.set("targetId", params.targetId)
  return `/dashboard/reports${query.size ? `?${query.toString()}` : ""}`
}

export function withPreservedSearchParams(
  href: string,
  current: URLSearchParams,
  keys: string[]
): string {
  const destination = new URL(href, "https://lyrashield.invalid")
  for (const key of keys) destination.searchParams.delete(key)
  for (const key of keys) {
    if (current.has(key)) destination.searchParams.set(key, current.get(key)!)
  }
  return `${destination.pathname}${destination.search}`
}

/**
 * API query parameters for a parsed list state. Open is the default view and
 * is queried explicitly; ALL applies no status/severity constraint.
 */
export function findingFilterToApiQuery(filter: FindingFilter): Record<string, string> {
  if (filter === "ALL") return {}
  if (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(filter)) {
    return { severity: filter }
  }
  if (filter === "VERIFIED") return { verified: "true" }
  return { status: filter }
}
