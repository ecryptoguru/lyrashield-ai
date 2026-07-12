"use client"

import { useEffect } from "react"

export function ReferralClaim() {
  useEffect(() => {
    void fetch("/api/referrals/claim", { method: "POST" })
  }, [])
  return null
}
