"use client"

import { useState } from "react"
import { Button } from "@lyrashield/ui"

export function LocalCheckoutButton({ available }: { available: boolean }) {
  const [accepted, setAccepted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function checkout() {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/billing/local-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      const body = (await response.json()) as {
        data?: { url?: string }
        error?: { message?: string }
      }
      if (!response.ok || !body.data?.url) {
        setError(body.error?.message ?? "Checkout could not be started. Please try again.")
        return
      }
      window.location.assign(body.data.url)
    } catch {
      setError("Checkout could not be started. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 text-sm leading-6">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          I agree to the{" "}
          <a
            href="https://lyrashieldai.com/terms-of-sale"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Terms of Sale
          </a>{" "}
          and understand that Local licenses are non-refundable except where required by law or for
          duplicate or unauthorized charges.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button className="w-full" disabled={!available || !accepted || loading} onClick={checkout}>
        {loading
          ? "Opening secure checkout…"
          : available
            ? "Continue to secure checkout"
            : "Purchases temporarily unavailable"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Payment details are collected by Polar or Razorpay. LyraShield does not receive card data.
      </p>
    </div>
  )
}
