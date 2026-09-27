import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"
import {
  FindingsClient,
  type FindingListItem,
} from "../../apps/web/src/app/(dashboard)/dashboard/findings/findings-client"
import { parseFindingListParams } from "../../apps/web/src/lib/finding-list-params"

export const initialFinding: FindingListItem = {
  id: "initial",
  title: "Initial finding",
  summary: "Initial summary",
  severity: "HIGH",
  status: "OPEN",
  verified: false,
  verificationStatus: "NOT_VERIFIED",
  confidence: "medium",
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-09-01T00:00:00.000Z",
}

export default function FindingsHarness() {
  const searchParams = new URLSearchParams(location.search)
  const params = parseFindingListParams(Object.fromEntries(searchParams))
  const hasPages = searchParams.has("hasPages")
  const initialData = searchParams.has("withPassingRetest")
    ? [{ ...initialFinding, title: "Fixed scoped finding", status: "FIXED" }]
    : [initialFinding]
  return (
    <WebMcpReceiptProvider>
      <main>
        <FindingsClient
          workspaceId="workspace-test"
          initialData={initialData}
          initialNextCursor={hasPages ? "cursor-1" : null}
          initialFilter={params.filter}
          initialSort={params.sort}
          initialScanId={params.scanId}
          initialTargetFilter={params.target}
          initialQuery={params.q}
          targets={[{ id: "target-test", name: "Test target" }]}
        />
      </main>
    </WebMcpReceiptProvider>
  )
}
