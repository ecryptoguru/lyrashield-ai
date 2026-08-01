"use client"

import { ApiErrorCard } from "@/components/api-error-card"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ApiErrorCard error={error} reset={reset} />
}
