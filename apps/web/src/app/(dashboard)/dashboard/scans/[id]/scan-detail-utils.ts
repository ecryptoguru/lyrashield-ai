import { useEffect, useState } from "react"
import type { ScanEvent } from "./scan-detail-types"

export const ELAPSED_TIME_INTERVAL_MS = 1_000
export const COMPLETION_NOTICE_DISMISS_MS = 6_000
/** Matches the service's event window cap (getScanWithEvents take: 200). */
export const MAX_EVENT_WINDOW = 200

/** Ticking elapsed time from a start timestamp, returning a formatted string. */
export function useElapsedTime(startedAt: string | null): string {
  // Keep server and first client render identical; the effect starts the live clock.
  const [elapsed, setElapsed] = useState("—")
  useEffect(() => {
    if (!startedAt) return
    const tick = () => setElapsed(formatDuration(startedAt, null))
    tick()
    const id = window.setInterval(tick, ELAPSED_TIME_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [startedAt])
  return elapsed
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—"
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  const diffSec = Math.round((endMs - startMs) / 1000)
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`
  return `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`
}

export function asIsoString(value: string | Date | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

// Event ordering for the incremental merge. The API returns events newest-first
// and the client stores them ascending; a stale full window and a fresh
// incremental tail can interleave, so comparisons never assume response order.
export function isEventAtOrAfterCursor(
  event: { createdAt: string; id: string },
  cursor: ScanEvent
) {
  if (event.createdAt > cursor.createdAt) return true
  if (event.createdAt < cursor.createdAt) return false
  return event.id >= cursor.id
}

/**
 * Merge a poll's events into the full client-side history. With a proven
 * cursor (`eventsCursorApplied` echoed by the server) the payload is a tail:
 * append strictly-new events and trim back to the 200-event window. Without
 * one — initial load, no cursor sent, unknown-cursor fallback, or a response
 * that raced a local trim — the payload is the authoritative full window and
 * replaces local state wholesale.
 */
export function mergeEvents(current: ScanEvent[], incoming: ScanEvent[], cursorApplied: boolean) {
  if (!cursorApplied) return incoming
  const cursor = current.at(-1)
  if (!cursor) return incoming
  const seen = new Set(current.map((event) => event.id))
  // A retried poll can re-deliver the same tail; a late response from a poll
  // started before the newest one can also arrive. Dropping ids the client
  // already holds covers both; the at-or-after check is belt-and-braces for a
  // malformed tail.
  const newEvents = incoming.filter(
    (event) => !seen.has(event.id) && isEventAtOrAfterCursor(event, cursor)
  )
  const merged = [...current, ...newEvents]
  return merged.length > MAX_EVENT_WINDOW ? merged.slice(merged.length - MAX_EVENT_WINDOW) : merged
}

export function asMetadata(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
