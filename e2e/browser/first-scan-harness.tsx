import { useEffect, useState } from "react"
import { TargetsClient } from "../../apps/web/src/app/(dashboard)/dashboard/targets/targets-client"
import { ScansClient } from "../../apps/web/src/app/(dashboard)/dashboard/scans/scans-client"
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"

// Exercises production components with explicit fixture data. No real scan is submitted.
export function FirstScanHarness() {
  const [destination, setDestination] = useState("")
  useEffect(() => {
    const onNavigate = (event: Event) => setDestination((event as CustomEvent<string>).detail)
    window.addEventListener("test:navigate", onNavigate)
    return () => window.removeEventListener("test:navigate", onNavigate)
  }, [])
  const targetId = destination.includes("new=1")
    ? new URL(destination, location.origin).searchParams.get("target")
    : null
  return (
    <WebMcpReceiptProvider>
      <TooltipProvider>
        {targetId ? (
          <ScansClient
            principalId="user-test"
            workspaceId="workspace-test"
            targets={[
              {
                id: targetId,
                name: "example.com",
                type: "WEB_APP",
                url: "https://example.com",
                apiSpecUrl: null,
                repoFullName: null,
              },
            ]}
            initialData={[]}
            initialNextCursor={null}
            initialShowCreate
            initialTargetId={targetId}
          />
        ) : destination.startsWith("/dashboard/scans/") ? (
          <p role="status">Scan progress: {destination}</p>
        ) : (
          <TargetsClient
            workspaceId="workspace-test"
            scanSetup
            initialData={[]}
            githubConnected={new URLSearchParams(location.search).has("github-connected")}
          />
        )}
      </TooltipProvider>
    </WebMcpReceiptProvider>
  )
}
