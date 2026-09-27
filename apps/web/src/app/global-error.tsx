"use client"

import "./globals.css"
import { ErrorSurface } from "./error-surface"

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body>
        <ErrorSurface reset={reset} />
      </body>
    </html>
  )
}
