import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ScanList } from "./scan-list"
import type { ScanItem } from "./scan-types"

describe("scan retry setup", () => {
  it("uses an in-page action so a retry opens the current composer", () => {
    const scan: ScanItem = {
      id: "scan-1",
      status: "FAILED",
      goal: "TEST_APP",
      mode: "STANDARD",
      triggerType: "MANUAL",
      startedAt: null,
      endedAt: null,
      summary: null,
      errorCategory: "TIMEOUT",
      errorMessage: null,
      target: {
        id: "target-1",
        name: "Example",
        type: "REPO",
        url: null,
        repoFullName: "owner/example",
      },
      createdAt: "2026-09-23T00:00:00.000Z",
    }
    const html = renderToStaticMarkup(
      <ScanList
        scans={[scan]}
        refreshing={false}
        nextCursor={null}
        loadingMore={false}
        targetFilter=""
        stateFilter="ALL"
        hasTargets
        onClearFilters={() => {}}
        onShowCreate={() => {}}
        onRetryScan={() => {}}
        cancelling={null}
        removing={null}
        onCancelScan={async () => {}}
        onRemoveScan={async () => {}}
        onLoadMore={async () => {}}
      />
    )

    expect(html).toMatch(/<button[^>]*aria-label="Retry setup for Example"/)
    expect(html).not.toContain("/dashboard/scans?new=1")
  })
})
