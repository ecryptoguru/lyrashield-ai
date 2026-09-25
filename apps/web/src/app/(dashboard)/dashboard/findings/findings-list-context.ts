import { z } from "zod"
import { findingListItemSchema } from "@/lib/api-schemas"
import type { FindingListItem } from "./findings-client"

/** Session-only navigation hint. Fresh server data remains authoritative. */
const MAX_PERSISTED_ROWS = 500
const pageSchema = z.object({
  items: z.array(findingListItemSchema).min(1),
  nextCursor: z.string().nullable(),
})
const snapshotSchema = z
  .object({
    version: z.literal(2),
    pages: z.array(pageSchema).min(1),
    scrollY: z.number().finite().nonnegative(),
  })
  .refine(
    (value) =>
      value.pages.reduce((count, page) => count + page.items.length, 0) <= MAX_PERSISTED_ROWS
  )

export interface FindingsListPage {
  items: FindingListItem[]
  nextCursor: string | null
}

export interface FindingsListContext {
  pages: FindingsListPage[]
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
    const pages: FindingsListPage[] = []
    let count = 0
    for (const page of context.pages) {
      if (page.items.length === 0 || count + page.items.length > MAX_PERSISTED_ROWS) break
      pages.push(page)
      count += page.items.length
    }
    if (!pages.length) return
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ version: 2, pages, scrollY: context.scrollY })
    )
  } catch {
    // Session storage can be unavailable or full; live list data is unaffected.
  }
}

export function loadFindingsListContext(key: string): FindingsListContext | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = snapshotSchema.safeParse(JSON.parse(raw))
    return parsed.success ? { pages: parsed.data.pages, scrollY: parsed.data.scrollY } : null
  } catch {
    return null
  }
}
