"use client"

import { useEffect, useState } from "react"
import { formatDate, formatDateTime, formatLocalDate, formatLocalDateTime } from "@/lib/date-format"

/**
 * Casual UI dates in the viewer's timezone without a hydration mismatch:
 * the first client render matches the SSR'd UTC label, then swaps to local
 * time after mount. Both forms name their zone, so the swap changes the clock
 * but never the meaning. Evidence surfaces (reports, manifests, exports) keep
 * the deterministic UTC formatters instead.
 */
export function LocalTime({
  value,
  withTime,
  className,
}: {
  value: Date | string | number
  withTime?: boolean
  className?: string
}) {
  const [text, setText] = useState(() => (withTime ? formatDateTime(value) : formatDate(value)))
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount timezone flip; first render must match the SSR'd UTC label
    setText(withTime ? formatLocalDateTime(value) : formatLocalDate(value))
  }, [value, withTime])
  return (
    <span className={className} title={formatDateTime(value)}>
      {text}
    </span>
  )
}
