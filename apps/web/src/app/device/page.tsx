"use client"

import { useSearchParams } from "next/navigation"
import { useState } from "react"
import { authClient } from "@lyrashield/auth"

export default function DevicePage() {
  const params = useSearchParams()
  const [userCode, setUserCode] = useState(params.get("user_code") ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function continueDevice() {
    setBusy(true)
    setError(null)
    const code = userCode.trim().replace(/-/g, "").toUpperCase()
    try {
      const result = await authClient.device({ query: { user_code: code } })
      if (!result.data) throw new Error("That device code is invalid or expired.")
      window.location.assign(`/device/approve?user_code=${encodeURIComponent(code)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That device code is invalid or expired.")
      setBusy(false)
    }
  }

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <form
        className="bg-card w-full max-w-md rounded-2xl border p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault()
          void continueDevice()
        }}
      >
        <p className="text-muted-foreground text-sm">LyraShield AI CLI connection</p>
        <h1 className="mt-2 text-2xl font-semibold">Authorize a device</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          Enter the code shown by your CLI. You will choose the workspace and review access before
          approving.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="user-code">
          Device code
        </label>
        <input
          id="user-code"
          autoComplete="one-time-code"
          value={userCode}
          onChange={(event) => setUserCode(event.target.value)}
          className="border-input bg-background mt-2 min-h-11 w-full rounded-md border px-3 font-mono uppercase"
          disabled={busy}
        />
        {error ? (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="bg-primary text-primary-foreground mt-6 min-h-11 w-full rounded-md px-4 text-sm font-medium disabled:opacity-50"
          disabled={busy || !userCode.trim()}
        >
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
    </main>
  )
}
