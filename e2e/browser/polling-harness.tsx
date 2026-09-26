import { useCallback, useEffect, useRef, useState } from "react"
import { useActiveScansPolling } from "../../apps/web/src/app/(dashboard)/dashboard/scans/use-active-scans-polling"
import { ScanDetailClient } from "../../apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"
import type { ScanItem } from "../../apps/web/src/app/(dashboard)/dashboard/scans/scan-types"
import type { ScanData } from "../../apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-types"

const startedAt = "2026-09-19T10:00:00.000Z"
const item: ScanItem = {
  id: "scan-a",
  status: "RUNNING",
  goal: "TEST_APP",
  mode: "STANDARD",
  triggerType: "manual",
  startedAt,
  endedAt: null,
  summary: null,
  errorCategory: null,
  errorMessage: null,
  target: null,
  createdAt: startedAt,
}

function ListHarness() {
  const [workspaceId, setWorkspaceId] = useState("ws-a")
  const [scans, setScans] = useState<ScanItem[]>([item])
  const [stale, setStale] = useState(false)
  const scansRef = useRef(scans)
  useEffect(() => {
    scansRef.current = scans
  }, [scans])
  const firstPageIdsRef = useRef(new Set([item.id]))
  const firstPageHasMoreRef = useRef(false)
  const listParams = useCallback(() => ({ workspaceId }), [workspaceId])
  useActiveScansPolling({
    hasActiveScans: scans.some((scan) => ["RUNNING", "VERIFYING"].includes(scan.status)),
    workspaceId,
    listParams,
    stateFilter: "ALL",
    targetFilter: "",
    scansRef,
    firstPageIdsRef,
    firstPageHasMoreRef,
    setScans,
    setPollStale: setStale,
  })
  return (
    <main>
      <h1>Scan list</h1>
      <output>
        {workspaceId}: {scans.map((scan) => scan.status).join(",")}
      </output>
      {stale && <p role="alert">Refresh failed</p>}
      <button onClick={() => setWorkspaceId("ws-b")}>Switch workspace</button>
    </main>
  )
}

const scan: ScanData = {
  ...item,
  workspaceId: "ws-a",
  events: [],
  executionPlan: null,
  integrity: { manifestChecksum: null, coverage: [] },
  aiSecurity: null,
}

export default function PollingHarness() {
  const [detailId, setDetailId] = useState("scan-a")
  return (
    <WebMcpReceiptProvider>
      {new URLSearchParams(location.search).get("polling") === "detail" ? (
        <>
          <button onClick={() => setDetailId("scan-b")}>Switch scan</button>
          <ScanDetailClient
            key={detailId}
            scan={{ ...scan, id: detailId }}
            findings={[]}
            scorecard={null}
          />
        </>
      ) : (
        <ListHarness />
      )}
    </WebMcpReceiptProvider>
  )
}
