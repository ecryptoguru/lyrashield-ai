"use client"

import { ErrorSurface } from "./error-surface"

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <ErrorSurface reset={reset} />
}
