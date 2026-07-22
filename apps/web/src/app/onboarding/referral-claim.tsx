"use client"

import { useEffect } from "react"

export function ReferralClaim() {
  useEffect(() => {
    fetch("/api/referrals/claim", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  }, [])
  return null
}
