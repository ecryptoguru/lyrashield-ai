import type { FindingHistoryCollection } from "./finding-service"

export const HISTORY_PREVIEW_LIMIT = 25

interface HistoryCursor {
  findingId: string
  collection: FindingHistoryCollection
  createdAt: string
  id: string
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

export function decodeHistoryCursor(
  value: string | undefined,
  findingId: string,
  collection: FindingHistoryCollection
): HistoryCursor | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("findingId" in parsed) ||
      !("collection" in parsed) ||
      !("id" in parsed) ||
      !("createdAt" in parsed) ||
      parsed.findingId !== findingId ||
      parsed.collection !== collection ||
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return null
    }
    return { findingId, collection, createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return null
  }
}

export const buildHistoryPreview = <T extends { id: string; createdAt?: Date }>(
  findingId: string,
  collection: FindingHistoryCollection,
  rows: T[],
  total: number
) => {
  const items = rows.slice(0, HISTORY_PREVIEW_LIMIT)
  const last = items.at(-1)
  const nextCursor =
    rows.length > HISTORY_PREVIEW_LIMIT && last?.createdAt
      ? encodeHistoryCursor({
          findingId,
          collection,
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        })
      : null
  return { items, pagination: { total, nextCursor } }
}
