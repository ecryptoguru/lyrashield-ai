import type { FindingListItem } from "./findings-client"

/**
 * W2-12: findings list context preservation.
 *
 * The URL already carries filter/sort/target/query (server-parsed, so a fresh
 * load restores them). What the URL cannot carry is the pages the user loaded
 * beyond the first server-rendered page and their scroll position. This module
 * persists that per-session context so navigating away and back restores the
 * exact list state instead of collapsing to the first 25 rows.
 *
 * Storage is sessionStorage (per-tab, auto-cleared), best-effort, and bounded:
 * a corrupt or oversized payload is discarded rather than breaking the list.
 */

const MAX_PERSISTED_ROWS = 500

export interface FindingsListContext {
  rows: FindingListItem[]
  nextCursor: string | null
  scrollY: number
}

export function findingsContextKey(
  workspaceId: string,
  context: { filter: string; sort: string; target: string; q: string }
): string {
  return `lyrashield:findings-list:${workspaceId}:${context.filter}:${context.sort}:${context.target}:${context.q}`
}

export function sameListContext(
  a: { filter: string; sort: string; target: string; q: string },
  b: { filter: string; sort: string; target: string; q: string }
): boolean {
  return a.filter === b.filter && a.sort === b.sort && a.target === b.target && a.q === b.q
}

export function saveFindingsListContext(key: string, context: FindingsListContext): void {
  if (typeof window === "undefined") return
  try {
    const rows = context.rows.slice(0, MAX_PERSISTED_ROWS)
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ rows, nextCursor: context.nextCursor, scrollY: context.scrollY })
    )
  } catch {
    // Storage may be unavailable (private mode, quota). Context loss is
    // acceptable; the list falls back to the server-rendered first page.
  }
}

export function loadFindingsListContext(key: string): FindingsListContext | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { rows, nextCursor, scrollY } = parsed as {
      rows?: unknown
      nextCursor?: unknown
      scrollY?: unknown
    }
    if (!Array.isArray(rows) || rows.length === 0) return null
    if (rows.length > MAX_PERSISTED_ROWS) return null
    return {
      rows: rows as FindingListItem[],
      nextCursor: typeof nextCursor === "string" ? nextCursor : null,
      scrollY: typeof scrollY === "number" ? scrollY : 0,
    }
  } catch {
    return null
  }
}
