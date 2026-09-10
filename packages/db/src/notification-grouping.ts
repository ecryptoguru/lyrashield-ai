import { createHash } from "node:crypto"

/**
 * W3-06: routine-notification grouping policy.
 *
 * Critical, actionable signals — blocked automation, connection failures,
 * important findings, meaningful assessment changes — are never grouped or
 * delayed: they always deliver individually. Routine completions coalesce
 * into one digest per group window using the existing dedupe-key mechanism,
 * so webhook/worker retries and completion batches cannot storm a channel.
 *
 * Preferences and tenant privacy are unchanged: grouping only merges events
 * the caller already decided to send, per workspace, through the existing
 * delivery providers.
 */

const CRITICAL_NOTIFICATION_TYPES = new Set([
  "scan.failed",
  "finding.critical",
  "finding.high",
  "connection.failed",
  "connection.revoked",
  "automation.blocked",
  "schedule.failed",
  "budget.exhausted",
  "queue.blocked",
  // A merged fix PR whose automatic retest could not be scheduled after the
  // maximum retry count. Blocked automation with a manual recovery action.
  "loop_closure_failed",
])

export type NotificationPriority = "critical" | "routine"

export function classifyNotificationPriority(type: string): NotificationPriority {
  if (CRITICAL_NOTIFICATION_TYPES.has(type)) return "critical"
  return "routine"
}

export function isCriticalNotification(type: string): boolean {
  return classifyNotificationPriority(type) === "critical"
}

/**
 * Dedupe key for a routine group window: every routine event in the same
 * workspace+group+window coalesces into one notification row. The window key
 * is caller-supplied so the digest cadence is explicit at the call site.
 */
export function routineGroupDedupeKey(input: {
  workspaceId: string
  groupType: string
  windowKey: string
}): string {
  return createHash("sha256")
    .update(`group:${input.workspaceId}:${input.groupType}:${input.windowKey}`)
    .digest("hex")
}

const DIGEST_MAX_ENTRIES = 10
const OVERFLOW_LINE_PREFIX = "…and "

/**
 * Builds the grouped digest payload for a batch of routine events. The body
 * lists each event's one-line receipt so no decision evidence is lost, bounded
 * to `maxEntries` lines with an explicit overflow note — never silently
 * truncated.
 */
export function buildRoutineDigest(params: {
  groupType: string
  windowLabel: string
  items: { title: string; detail: string }[]
  maxEntries?: number
}): { type: string; title: string; body: string } {
  const maxEntries = params.maxEntries ?? DIGEST_MAX_ENTRIES
  const count = params.items.length
  const shown = params.items.slice(0, maxEntries)
  const overflow = count - shown.length
  const lines = shown.map((item) => `• ${item.title} — ${item.detail}`)
  if (overflow > 0)
    lines.push(
      `${OVERFLOW_LINE_PREFIX}${overflow} more in this window (see the dashboard activity log)`
    )

  return {
    type: `digest.${params.groupType}`,
    title: `${params.groupType} — ${count} update${count === 1 ? "" : "s"}`,
    body: `${params.windowLabel}\n\n${lines.join("\n")}`,
  }
}

/**
 * Appends one event receipt to an existing digest body without erasing
 * earlier events in the window. Duplicate lines (webhook/worker retries) are
 * ignored; the entry list stays bounded with an explicit overflow note.
 */
export function appendDigestLine(
  body: string,
  line: string,
  maxEntries = DIGEST_MAX_ENTRIES
): string {
  const lines = body.split("\n")
  if (lines.includes(line)) return body

  const blankIndex = lines.indexOf("")
  const header = blankIndex === -1 ? [] : lines.slice(0, blankIndex + 1)
  const rest = blankIndex === -1 ? lines : lines.slice(blankIndex + 1)
  const entries = rest.filter((line) => line.startsWith("• "))
  const overflowLine = rest.find((line) => line.startsWith(OVERFLOW_LINE_PREFIX))
  const priorOverflow = overflowLine ? Number(overflowLine.match(/(\d+) more/)?.[1] ?? 0) : 0

  const all = [...entries, line]
  const shown = all.slice(0, maxEntries)
  const totalOverflow = all.length - shown.length + priorOverflow

  const out = [...header]
  for (const entry of shown) out.push(entry)
  if (totalOverflow > 0) {
    out.push(
      `${OVERFLOW_LINE_PREFIX}${totalOverflow} more in this window (see the dashboard activity log)`
    )
  }
  return out.join("\n")
}
