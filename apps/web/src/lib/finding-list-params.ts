import type { SortMode } from "@/app/(dashboard)/dashboard/findings/findings-client"

/**
 * Server-parsed findings-list state.
 *
 * The filter/sort state must be parsed on the server and passed into the client
 * component as initial props. Reading `window.location.search` inside a
 * useState initializer renders different first trees on server and client
 * (server sees no URL, the browser sees `?filter=…`), which is the hydration
 * divergence behind React error #418 on authenticated routes — and once
 * hydration diverges, streamed Suspense boundary completion crashes with the
 * `$RS`/`parentNode` TypeError.
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

export interface FindingListParams {
  filter: FindingFilter
  sort: SortMode
}

export function parseFindingListParams(params: {
  filter?: string
  sort?: string
}): FindingListParams {
  const filter = (FINDING_FILTERS as readonly string[]).includes(params.filter ?? "")
    ? (params.filter as FindingFilter)
    : "ALL"
  const sort = (FINDING_SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as SortMode)
    : "priority"
  return { filter, sort }
}
