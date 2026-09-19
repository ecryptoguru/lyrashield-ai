import { useEffect, useState } from "react"
import App from "../../apps/desktop/frontend/src/App"
import { ScanProgressScreen } from "../../apps/desktop/frontend/src/screens/ScanProgressScreen"
export default function DesktopHarness() {
  const [scanId, setScanId] = useState("scan-a")
  useEffect(() => {
    const change = () => setScanId("scan-b")
    window.addEventListener("test:scan-change", change)
    return () => window.removeEventListener("test:scan-change", change)
  }, [])
  return new URLSearchParams(location.search).get("desktop") === "progress" ? (
    <ScanProgressScreen
      scanId={scanId}
      onBack={() => {
        location.hash = "back"
      }}
    />
  ) : (
    <App />
  )
}
