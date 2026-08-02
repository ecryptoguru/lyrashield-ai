import { z } from "zod"
import type { LyraShieldClient } from "./client"

export interface PaginationParams {
  cursor?: string
  limit?: number
}

export interface Paginated<T> {
  items: T[]
  nextCursor: string | null
  total?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MIN_LIMIT = 1

function normalizeLimit(limit?: number): number {
  if (!limit) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limit)))
}

export async function* paginate<T>(
  client: LyraShieldClient,
  method: "GET" | "POST",
  path: string,
  params: PaginationParams | undefined,
  itemSchema: z.ZodType<T>
): AsyncGenerator<Paginated<T>, void, unknown> {
  let cursor: string | undefined = params?.cursor

  const pageSchema = z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    total: z.number().optional(),
  })

  while (true) {
    const limit = normalizeLimit(params?.limit)
    const query = new URLSearchParams()
    query.set("limit", String(limit))
    if (cursor) query.set("cursor", cursor)

    const separator = path.includes("?") ? "&" : "?"
    const pagePath = `${path}${separator}${query.toString()}`

    const page = await client.request(method, pagePath, {
      parse: (data) => pageSchema.parse(data),
    })
    if (!page || !Array.isArray(page.items)) break

    yield page

    cursor = page.nextCursor ?? undefined
    if (!cursor) break
  }
}

export async function listAll<T>(
  client: LyraShieldClient,
  method: "GET" | "POST",
  path: string,
  itemSchema: z.ZodType<T>,
  params?: PaginationParams
): Promise<T[]> {
  const items: T[] = []
  for await (const page of paginate<T>(client, method, path, params, itemSchema)) {
    items.push(...page.items)
  }
  return items
}
