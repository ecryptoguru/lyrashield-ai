import type { SortMode } from "@/app/(dashboard)/dashboard/findings/findings-client"

export function updateFindingListUrl(updates: {
  filter?: string
  sort?: SortMode
  target?: string
  q?: string
}) {
  if (typeof window === "undefined") return
  const params = new URLSearchParams(window.location.search)
  if (updates.filter !== undefined) {
    const selection = decodeFindingFilters(updates.filter)
    params.delete("filter")
    params.set("status", selection.status)
    if (selection.severity === "ALL") params.delete("severity")
    else params.set("severity", selection.severity)
    if (selection.evidence === "ALL") params.delete("evidence")
    else params.set("evidence", selection.evidence)
  }
  if (updates.sort !== undefined) {
    if (updates.sort !== "priority") params.set("sort", updates.sort)
    else params.delete("sort")
  }
  if (updates.target !== undefined) {
    params.delete("targetId")
    if (updates.target) params.set("target", updates.target)
    else params.delete("target")
  }
  if (updates.q !== undefined) {
    if (updates.q) params.set("q", updates.q)
    else params.delete("q")
  }
  const search = params.toString()
  const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}`
  if (nextUrl === `${window.location.pathname}${window.location.search}`) return
  const method =
    updates.filter !== undefined || updates.target !== undefined || updates.sort !== undefined
      ? "pushState"
      : "replaceState"
  window.history[method](null, "", nextUrl)
}

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
 * URL contract: status, severity, and evidence combine independently. Missing
 * status defaults to Open; All is explicit. Legacy filter links keep their
 * original exclusive scope until the user changes a selection.
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

// A canonical selection travels through the existing list, history, and
// WebMCP undo contracts. Legacy exclusive links retain their original scope.
export const FINDING_STATUSES = [
  "ALL",
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
  "FIXED",
  "ACCEPTED_RISK",
  "FALSE_POSITIVE",
  "DUPLICATE",
] as const
export const FINDING_SEVERITIES = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const
export const FINDING_EVIDENCE = ["ALL", "VERIFIED", "UNVERIFIED"] as const
export type FindingFilters = {
  status: (typeof FINDING_STATUSES)[number]
  severity: (typeof FINDING_SEVERITIES)[number]
  evidence: (typeof FINDING_EVIDENCE)[number]
}
export type FindingFilter =
  | (typeof FINDING_FILTERS)[number]
  | `${FindingFilters["status"]}:${FindingFilters["severity"]}:${FindingFilters["evidence"]}`

export function encodeFindingFilters(filters: FindingFilters): FindingFilter {
  if (
    filters.severity === "ALL" &&
    filters.evidence === "ALL" &&
    ["OPEN", "ALL", "FIXED"].includes(filters.status)
  )
    return filters.status as FindingFilter
  return `${filters.status}:${filters.severity}:${filters.evidence}`
}

export function decodeFindingFilters(filter: string): FindingFilters {
  const [status, severity, evidence] = filter.split(":")
  if (
    (FINDING_STATUSES as readonly string[]).includes(status ?? "") &&
    (FINDING_SEVERITIES as readonly string[]).includes(severity ?? "") &&
    (FINDING_EVIDENCE as readonly string[]).includes(evidence ?? "")
  ) {
    return {
      status: status as FindingFilters["status"],
      severity: severity as FindingFilters["severity"],
      evidence: evidence as FindingFilters["evidence"],
    }
  }
  if ((FINDING_SEVERITIES as readonly string[]).includes(filter) && filter !== "ALL")
    return { status: "ALL", severity: filter as FindingFilters["severity"], evidence: "ALL" }
  if (filter === "VERIFIED") return { status: "ALL", severity: "ALL", evidence: "VERIFIED" }
  return {
    status: filter === "ALL" || filter === "FIXED" ? filter : "OPEN",
    severity: "ALL",
    evidence: "ALL",
  }
}

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
  status?: string
  severity?: string
  evidence?: string
  sort?: string
  scanId?: string
  target?: string
  targetId?: string
  q?: string
}): FindingListParams {
  let filter = (FINDING_FILTERS as readonly string[]).includes(params.filter ?? "")
    ? (params.filter as FindingFilter)
    : DEFAULT_FINDING_FILTER
  if (
    params.status !== undefined ||
    params.severity !== undefined ||
    params.evidence !== undefined
  ) {
    const legacy = decodeFindingFilters(filter)
    filter = encodeFindingFilters({
      status: (FINDING_STATUSES as readonly string[]).includes(params.status ?? "")
        ? (params.status as FindingFilters["status"])
        : legacy.status,
      severity: (FINDING_SEVERITIES as readonly string[]).includes(params.severity ?? "")
        ? (params.severity as FindingFilters["severity"])
        : legacy.severity,
      evidence: (FINDING_EVIDENCE as readonly string[]).includes(params.evidence ?? "")
        ? (params.evidence as FindingFilters["evidence"])
        : legacy.evidence,
    })
  }
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
  const selection = decodeFindingFilters(filter)
  return {
    ...(selection.status !== "ALL" ? { status: selection.status } : {}),
    ...(selection.severity !== "ALL" ? { severity: selection.severity } : {}),
    ...(selection.evidence !== "ALL"
      ? { verified: selection.evidence === "VERIFIED" ? "true" : "false" }
      : {}),
  }
}
