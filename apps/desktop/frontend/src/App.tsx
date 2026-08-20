import { useEffect, useState } from "react"
import type { LicenseStatus } from "./lib/types"
import { clearLicense, getLicenseStatus } from "./lib/tauri"
import { ActivationScreen } from "./screens/ActivationScreen"
import { LicenseStatusScreen } from "./screens/LicenseStatusScreen"
import { SetupScreen } from "./screens/SetupScreen"

type AppRoute = "activation" | "setup" | "main" | "loading"

export default function App() {
  const [route, setRoute] = useState<AppRoute>("loading")
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)

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
    return <SetupScreen onComplete={() => setRoute("main")} onBack={() => setRoute("activation")} />
  }

  return (
    <LicenseStatusScreen
      status={licenseStatus}
      onLogout={async () => {
        await clearLicense()
        setRoute("activation")
      }}
    />
  )
}
