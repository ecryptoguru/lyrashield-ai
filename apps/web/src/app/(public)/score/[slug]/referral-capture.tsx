"use client"

import { useEffect } from "react"

export function ReferralCapture({
  code,
  source,
}: {
  code: string | undefined
  source: string | undefined
}) {
  useEffect(() => {
    if (!code) return
    fetch("/api/referrals/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, source }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  }, [code, source])
  return null
}
