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
  const params = parseFindingListParams(Object.fromEntries(new URLSearchParams(location.search)))
  return (
    <WebMcpReceiptProvider>
      <main>
        <FindingsClient
          workspaceId="workspace-test"
          initialData={[initialFinding]}
          initialNextCursor={null}
          initialFilter={params.filter}
          initialSort={params.sort}
          initialTargetFilter={params.target}
          initialQuery={params.q}
          targets={[{ id: "target-test", name: "Test target" }]}
        />
      </main>
    </WebMcpReceiptProvider>
  )
}
