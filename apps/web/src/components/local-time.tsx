"use client"

import { useEffect, useState } from "react"
import { formatDate, formatDateTime, formatLocalDate, formatLocalDateTime } from "@/lib/date-format"

/**
 * Casual UI dates in the viewer's timezone without a hydration mismatch:
 * the first client render matches the SSR'd UTC label, then swaps to local
 * time after mount. Evidence surfaces (reports, manifests, exports) should
 * keep the deterministic UTC formatters instead.
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
  const [text, setText] = useState(() =>
    withTime ? formatDateTime(value) : formatDate(value)
  )
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount timezone flip; first render must match the SSR'd UTC label
    setText(withTime ? formatLocalDateTime(value) : formatLocalDate(value))
  }, [value, withTime])
  return <span className={className}>{text}</span>
}
