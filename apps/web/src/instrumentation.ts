import type { Instrumentation } from "next"
import { logger } from "@lyrashield/logger"

/**
 * Sentry wiring for the Next.js server/edge runtimes.
 *
 * packages/config validates SENTRY_DSN (server) and NEXT_PUBLIC_SENTRY_DSN
 * (browser/client) but no SDK was previously initialised. We dynamically import
 * @sentry/nextjs inside register() so the module is only loaded (and the
 * dependency only required) when a DSN is actually configured — keeping dev and
 * DSN-less deploys a true no-op.
 *
 * NEXT_RUNTIME is "nodejs" | "edge" for the server entrypoints; the client
 * bundle sets neither and relies on NEXT_PUBLIC_SENTRY_DSN.
 */
export async function register(): Promise<void> {
  const serverDsn = process.env.SENTRY_DSN
  const publicDsn = process.env.NEXT_PUBLIC_SENTRY_DSN

  // Server (Node.js) runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!serverDsn) return
    const Sentry = await import("@sentry/nextjs")
    Sentry.init({
      dsn: serverDsn,
      environment: process.env.NODE_ENV,
      // Keep traces modest; this is an error-reporting wire-up, not APM tuning.
      tracesSampleRate: 0.1,
    })
    return
  }

  // Edge runtime.
  if (process.env.NEXT_RUNTIME === "edge") {
    if (!serverDsn) return
    const Sentry = await import("@sentry/nextjs")
    Sentry.init({
      dsn: serverDsn,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.1,
    })
    return
  }

  // Client (browser). Uses the public DSN only.
  if (publicDsn) {
    const Sentry = await import("@sentry/nextjs")
    Sentry.init({
      dsn: publicDsn,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.1,
    })
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  logger.error("Unhandled web request error", {
    path: request.path,
    method: request.method,
    route: context.routePath,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })

  // Mirror to Sentry when configured. captureRequestError is the Sentry-provided
  // onRequestError implementation; it is a no-op when the SDK was not initialised.
  if (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN) {
    try {
      const Sentry = await import("@sentry/nextjs")
      Sentry.captureRequestError(error, request, context)
    } catch (sentryError) {
      logger.warn("Sentry captureRequestError failed", {
        error: sentryError instanceof Error ? sentryError.message : String(sentryError),
      })
    }
  }
}
