"use client"

import { useEffect, useState } from "react"
import { Button } from "@lyrashield/ui"

type RetrievedLicense = {
  licenseKey: string
  licenseBlob: string
  licenseId: string
}

export default function LicenseRetrievalPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [license, setLicense] = useState<RetrievedLicense | null>(null)

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const fragmentToken = fragment.get("token")
    window.history.replaceState(null, "", window.location.pathname)
    const timer = window.setTimeout(() => {
      setToken(fragmentToken && fragmentToken.length >= 10 ? fragmentToken : null)
      setReady(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  async function retrieveLicense() {
    if (!token || loading) return
    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/licenses/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      const body = (await response.json()) as {
        success: boolean
        data?: RetrievedLicense
      }
      if (!response.ok || !body.success || !body.data) throw new Error("retrieval_failed")
      setLicense(body.data)
      setToken(null)
    } catch {
      setError("This retrieval link is invalid, expired, or already used.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-4 py-12 sm:px-6">
      <section className="w-full border border-border bg-card p-6 shadow-lg sm:p-10">
        <p className="text-sm font-semibold tracking-wide text-primary">LYRASHIELD LOCAL</p>
        <h1 className="mt-2 text-3xl font-semibold text-foreground">Retrieve your license</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Retrieval is single-use. Save both values somewhere private before leaving this page.
        </p>

        {!ready ? (
          <p className="mt-8 text-sm text-muted-foreground" role="status">
            Preparing secure retrieval…
          </p>
        ) : license ? (
          <div className="mt-8 space-y-5" aria-live="polite">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="license-key">
                License key
              </label>
              <textarea
                id="license-key"
                className="mt-2 min-h-20 w-full resize-y border border-input bg-background p-3 font-mono text-sm text-foreground"
                readOnly
                spellCheck={false}
                value={license.licenseKey}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="license-file">
                Signed license file
              </label>
              <textarea
                id="license-file"
                className="mt-2 min-h-48 w-full resize-y border border-input bg-background p-3 font-mono text-sm text-foreground"
                readOnly
                spellCheck={false}
                value={license.licenseBlob}
              />
            </div>
            <p className="text-xs text-muted-foreground">License reference: {license.licenseId}</p>
          </div>
        ) : token ? (
          <div className="mt-8">
            <p className="text-sm text-foreground">
              Your token has been removed from the address bar. Continue only on a private device.
            </p>
            <Button className="mt-5" disabled={loading} onClick={retrieveLicense} type="button">
              {loading ? "Retrieving…" : "Retrieve license once"}
            </Button>
          </div>
        ) : (
          <p className="mt-8 text-sm text-destructive" role="alert">
            This retrieval link is missing or invalid. Open the exact link from your purchase email.
          </p>
        )}

        {error ? (
          <p className="mt-5 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}
