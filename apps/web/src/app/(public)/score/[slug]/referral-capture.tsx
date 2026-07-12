"use client"

import { useEffect } from "react"

export function ReferralCapture({ code }: { code: string | undefined }) {
  useEffect(() => {
    if (!code) return
    void fetch("/api/referrals/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
  }, [code])
  return null
}
