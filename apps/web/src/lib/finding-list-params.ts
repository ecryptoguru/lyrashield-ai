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

export const FINDING_FILTERS = [
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

export const FINDING_SORTS = ["priority", "severity", "newest"] as const

export const DEFAULT_FINDING_FILTER: FindingFilter = "OPEN"

export interface FindingListParams {
  filter: FindingFilter
  sort: SortMode
  target: string
  q: string
}

export function parseFindingListParams(params: {
  filter?: string
  sort?: string
  target?: string
  q?: string
}): FindingListParams {
  const filter = (FINDING_FILTERS as readonly string[]).includes(params.filter ?? "")
    ? (params.filter as FindingFilter)
    : DEFAULT_FINDING_FILTER
  const sort = (FINDING_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as SortMode)
    : "priority"
  return {
    filter,
    sort,
    target: params.target?.trim() ?? "",
    q: params.q?.trim().slice(0, 120) ?? "",
  }
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
