import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ScanList } from "./scan-list"
import type { ScanItem } from "./scan-types"

describe("scan retry setup", () => {
  it("uses an in-page action so a retry opens the current composer", () => {
    const scan: ScanItem = {
      id: "scan-1",
      status: "FAILED",
      goal: "SECURITY_REVIEW",
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
    const scans = [
      scan,
      { ...scan, id: "scan-2", goal: "CHECK_PR" },
      { ...scan, id: "scan-3", goal: "FUTURE_REVIEW" },
      {
        ...scan,
        id: "scan-4",
        status: "COMPLETED",
        endedAt: "2026-09-23T00:05:00.000Z",
      },
    ]
    const html = renderToStaticMarkup(
      <ScanList
        scans={scans}
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
    expect(html).toContain("Security scan")
    expect(html).toContain("Check a PR")
    expect(html).toContain("Future review")
    expect(html).not.toContain("/dashboard/scans?new=1")
    expect(html).toContain("Sep 23, 2026, 00:00 UTC")
    expect(html).toContain("completed Sep 23, 2026, 00:05 UTC")
  })

  it("links the empty scans state directly to guided scan setup", () => {
    const html = renderToStaticMarkup(
      <ScanList
        scans={[]}
        refreshing={false}
        nextCursor={null}
        loadingMore={false}
        targetFilter=""
        stateFilter="ALL"
        hasTargets={false}
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

    expect(html).toContain('href="/dashboard/scans?new=1"')
    expect(html).toContain("Add a target")
  })
})
