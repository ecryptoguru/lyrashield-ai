import { logger } from "@lyrashield/logger"

/**
 * Slow-query logging for both Prisma clients (client.ts and system-client.ts).
 *
 * Prisma 7 pattern: register a `query` event emitter in the PrismaClient
 * constructor's `log` option and subscribe with `$on("query", ...)` on the
 * BASE client — listeners must be attached before `$extends`, because extended
 * clients do not expose `$on`.
 *
 * Privacy: the handler logs duration and the operation name only, never
 * `event.query` or `event.params`. The params field carries bind values that
 * can contain user data (emails, tokens, finding summaries), and the repo has
 * no `$queryRawUnsafe`/`$executeRawUnsafe` calls, so this loses nothing the
 * team needs for diagnosis. The listener parameter is declared structurally
 * (duration + query) rather than naming the generated `Prisma.QueryEvent`.
 */
export const SLOW_QUERY_THRESHOLD_MS = 500

/**
 * Extract the model/action pair from a query event WITHOUT logging query text.
 * Prisma 7 appends a trailing comment (`/* <action> for <model> *\/`) to the
 * SQL it emits through query events; strip it and never emit the remainder.
 */
export function describeQueryEvent(event: { query: string; duration: number }): {
  model: string | null
  action: string | null
  durationMs: number
} {
  const commentStart = event.query.lastIndexOf("/*")
  const operation =
    commentStart >= 0 ? event.query.slice(commentStart + 2, event.query.length - 2).trim() : null
  // Supported shape: "<action> for <model>". Anything else stays unattributed
  // rather than guessing (and never falling back to raw SQL text).
  const match = operation ? /^(\w+) for ([\w.]+)$/.exec(operation) : null
  return {
    model: match?.[2] ?? null,
    action: match?.[1] ?? null,
    durationMs: event.duration,
  }
}

/**
 * Subscribe the given base PrismaClient to slow-query events. Fast queries are
 * discarded without touching the logger; the per-query event emission cost is
 * the price of the timing signal (Prisma has no duration-threshold option).
 */
export function registerSlowQueryLogging(
  client: {
    $on(event: "query", listener: (event: { duration: number; query: string }) => void): unknown
  },
  options?: { scope?: string }
): void {
  const scope = options?.scope ?? "db"
  client.$on("query", (event) => {
    if (event.duration < SLOW_QUERY_THRESHOLD_MS) return
    const { model, action, durationMs } = describeQueryEvent(event)
    // duration + operation only; never event.query / event.params (they can
    // carry user data). The logger stamps its ambient requestId when one was
    // set for the current request.
    logger.warn("Slow database query", {
      scope,
      durationMs,
      model,
      action,
      thresholdMs: SLOW_QUERY_THRESHOLD_MS,
    })
  })
}
