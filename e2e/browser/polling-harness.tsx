import { useState } from "react"
import { WebMcpReceiptProvider } from "../../apps/web/src/components/webmcp/webmcp-receipt-provider"
import { useScanListState } from "../../apps/web/src/app/(dashboard)/dashboard/scans/use-scan-list-state"
import { ScansClient } from "../../apps/web/src/app/(dashboard)/dashboard/scans/scans-client"
import { ScanDetailClient } from "../../apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client"
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
  const [error, setError] = useState<string | null>(null)
  const [, setErrorCode] = useState<string | null>(null)
  const filtered = new URLSearchParams(location.search).has("filtered")
  const list = useScanListState({
    workspaceId,
    initialData: [item],
    initialNextCursor: "page-one",
    initialTargetFilter: "",
    initialStateFilter: filtered ? "ACTIVE" : "ALL",
    setError,
    setErrorCode,
  })
  return (
    <main>
      <h1>Scan list</h1>
      <output>
        {workspaceId}: {list.scans.map((scan) => scan.status).join(",")}
      </output>
      <ul aria-label="Scans">
        {list.scans.map((scan) => (
          <li key={scan.id}>{scan.id}</li>
        ))}
      </ul>
      <span aria-label="Cursor">{list.nextCursor ?? "end"}</span>
      {error && <p role="alert">{error}</p>}
      {list.pollStale && <p role="alert">Refresh failed</p>}
      <button onClick={() => setWorkspaceId("ws-b")}>Switch workspace</button>
      <button onClick={() => list.handleStateFilterChange("COMPLETED")}>Completed filter</button>
      <button onClick={() => list.handleClearFilters()}>Clear filters</button>
      <button onClick={() => void list.handleRefresh()}>Refresh list</button>
      <button
        onClick={() => void list.handleLoadMore()}
        disabled={list.loadingMore || !list.nextCursor}
      >
        Load more
      </button>
      <button onClick={() => void list.handleCancelScan("scan-a")}>Cancel scan</button>
      <button onClick={() => void list.handleRemoveScan("scan-a")}>Remove scan</button>
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
  const mode = new URLSearchParams(location.search).get("polling")
  return mode === "create" || mode === "client-list" ? (
    <WebMcpReceiptProvider>
      <ScansClient
        principalId="user-a"
        workspaceId="ws-a"
        targets={[
          {
            id: "target-a",
            name: "Example repository",
            type: "REPO",
            repoFullName: "example/repository",
            url: null,
            apiSpecUrl: null,
          },
        ]}
        initialData={[{ ...item, status: mode === "client-list" ? "RUNNING" : "COMPLETED" }]}
        initialNextCursor={mode === "client-list" ? "page-one" : null}
        initialStateFilter={mode === "client-list" ? "ACTIVE" : "ALL"}
        initialFilterUnavailable={new URLSearchParams(location.search).has("recovered")}
      />
    </WebMcpReceiptProvider>
  ) : mode === "detail" ? (
    <>
      <button onClick={() => setDetailId("scan-b")}>Switch scan</button>
      <WebMcpReceiptProvider>
        <ScanDetailClient
          key={detailId}
          scan={{ ...scan, id: detailId }}
          findings={[]}
          scorecard={null}
        />
      </WebMcpReceiptProvider>
    </>
  ) : (
    <ListHarness />
  )
}
