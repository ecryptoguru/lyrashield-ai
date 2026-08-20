import { useState } from "react"
import type { LicenseStatus } from "../lib/types"
import { activateLicense } from "../lib/tauri"

interface Props {
  onActivated: (status: LicenseStatus) => void
}

export function ActivationScreen({ onActivated }: Props) {
  const [licenseKey, setLicenseKey] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleActivate() {
    if (!licenseKey.trim()) {
      setError("Please enter your license key.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const status = await activateLicense(licenseKey.trim())
      onActivated(status)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Activate LyraShield</h1>
          <p className="text-sm text-muted-foreground">
            Enter the license key from your purchase email.
          </p>
        </div>
        <div className="space-y-4">
          <input
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && handleActivate()}
            placeholder="LYRA-XXXX-XXXX-XXXX"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            disabled={loading}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            onClick={handleActivate}
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Activating…" : "Activate License"}
          </button>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Don&apos;t have a license? Visit{" "}
          <a href="https://lyrashieldai.com" className="text-primary underline">
            lyrashieldai.com
          </a>
        </p>
      </div>
    </div>
  )
}
