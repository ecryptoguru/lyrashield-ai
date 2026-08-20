import { useEffect, useState } from "react"
import type { LicenseStatus } from "./lib/types"
import { clearLicense, getLicenseStatus } from "./lib/tauri"
import { ActivationScreen } from "./screens/ActivationScreen"
import { LicenseStatusScreen } from "./screens/LicenseStatusScreen"
import { ScanScreen } from "./screens/ScanScreen"
import { ScanProgressScreen } from "./screens/ScanProgressScreen"
import { SetupScreen } from "./screens/SetupScreen"
import { SyncScreen } from "./screens/SyncScreen"

type AppRoute = "activation" | "setup" | "main" | "scan" | "scan_progress" | "sync" | "loading"

export default function App() {
  const [route, setRoute] = useState<AppRoute>("loading")
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [activeScanId, setActiveScanId] = useState<string | null>(null)
  const [lastFindings] = useState<{ id: string; severity: string; title: string; description: string | null; filePath: string | null; lineNumber: number | null; status: string; verified: boolean; detectedAt: string }[]>([])

  useEffect(() => {
    async function checkLicense() {
      try {
        const status = await getLicenseStatus()
        setLicenseStatus(status)
        if (status.state === "none" || status.state === "revoked") {
          setRoute("activation")
        } else {
          setRoute("setup")
        }
      } catch {
        setRoute("activation")
      }
    }
    checkLicense()
  }, [])

  if (route === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading LyraShield…</p>
      </div>
    )
  }

  if (route === "activation") {
    return (
      <ActivationScreen
        onActivated={(status) => {
          setLicenseStatus(status)
          setRoute("setup")
        }}
      />
    )
  }

  if (route === "setup") {
    return (
      <SetupScreen
        onComplete={() => setRoute("main")}
        onBack={() => setRoute("activation")}
      />
    )
  }

  if (route === "scan") {
    return (
      <ScanScreen
        onScanStarted={(scanId) => {
          setActiveScanId(scanId)
          setRoute("scan_progress")
        }}
      />
    )
  }

  if (route === "scan_progress" && activeScanId) {
    return (
      <ScanProgressScreen
        scanId={activeScanId}
        onBack={() => setRoute("main")}
      />
    )
  }

  if (route === "sync") {
    return (
      <SyncScreen
        licenseKey={licenseStatus?.state === "active" ? "" : ""}
        findings={lastFindings}
      />
    )
  }

  // main
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h1 className="text-lg font-semibold text-foreground">LyraShield Local</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setRoute("scan")}
            className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            New Scan
          </button>
          <button
            onClick={() => setRoute("sync")}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Sync
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <LicenseStatusScreen
          status={licenseStatus}
          onLogout={async () => {
            await clearLicense()
            setRoute("activation")
          }}
        />
      </div>
    </div>
  )
}
