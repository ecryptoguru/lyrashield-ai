import { createHash } from "crypto"
import { z } from "zod"
import { MAX_CONCURRENT_WORKSPACE_SCANS } from "@lyrashield/types"
import type { ScanListItem } from "@lyrashield/db"

export const ScanIdQuerySchema = z
  .array(z.string().trim().min(1).max(128))
  .min(1)
  .max(MAX_CONCURRENT_WORKSPACE_SCANS)

/**
 * Serialize a scan list row for the client. Dates become ISO strings so the
 * polled payload matches the SSR-rendered shape exactly (the client's ScanItem
 * type expects strings, and `findingCount` is already flattened by listScans).
 */
export function serializeScanListItem(scan: ScanListItem) {
  return {
    ...scan,
    startedAt: scan.startedAt ? scan.startedAt.toISOString() : null,
    endedAt: scan.endedAt ? scan.endedAt.toISOString() : null,
    createdAt: scan.createdAt.toISOString(),
  }
}

/**
 * ETag over the entire response representation. The active-scan poll re-requests
 * this list on an interval; when nothing has moved the client gets a 304 with no
 * body to parse.
 *
 * Hashing the full payload (not a subset of fields) is deliberate: a summary,
 * error message, or target rename can change while status and counts stay put,
 * and a partial hash would then serve a 304 and freeze stale data on screen.
 */
export function scanListEtag(
  items: ReturnType<typeof serializeScanListItem>[],
  nextCursor: string | null
): string {
  // Hash the exact response representation, envelope included: the body is
  // { success, data: { items, nextCursor } }, so any envelope change also
  // invalidates the tag instead of serving a stale-shaped 304.
  const payload = JSON.stringify({ success: true, data: { items, nextCursor } })
  return `"${createHash("sha256").update(payload).digest("hex")}"`
}
