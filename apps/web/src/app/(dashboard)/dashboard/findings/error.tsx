"use client"

import { ApiErrorCard } from "@/components/api-error-card"

/**
 * Route boundary for Findings.
 *
 * Findings is the one dashboard route where a secondary query can blank a
 * working page: the list query, the target filter list and the deep-linked
 * finding are three independent reads, and a failure in any of them takes down
 * the whole render. This boundary keeps the recovery inside the route — retry,
 * or fall back to the unscoped list — instead of showing the generic dashboard
 * card with nowhere to go. No other route gets one.
 */
export default function FindingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <ApiErrorCard
      error={error}
      reset={reset}
      recovery={{ href: "/dashboard/findings?tab=issues", label: "All workspace findings" }}
    />
  )
}
