import { ReportsClient } from "../../apps/web/src/app/(dashboard)/dashboard/reports/reports-client"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"

export default function ReportsHarness() {
  const params = new URLSearchParams(location.search)
  return (
    <WebMcpReceiptProvider>
      <main>
        <h1>Reports</h1>
        <ReportsClient
          workspaceId="workspace-test"
          initialScanId={params.get("scanId") ?? undefined}
          initialTargetId={params.get("targetId") ?? undefined}
        />
      </main>
    </WebMcpReceiptProvider>
  )
}
