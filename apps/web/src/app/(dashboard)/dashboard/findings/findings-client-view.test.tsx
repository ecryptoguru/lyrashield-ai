import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { FindingsControls, FindingsResults } from "./findings-client-view"
import type { FindingListItem } from "./findings-client"

const callbacks = {
  handleFilterChange: vi.fn(async () => {}),
  handleTargetFilterChange: vi.fn(async () => {}),
  handleQueryChange: vi.fn(),
  setSortMode: vi.fn(),
  updateQueryParams: vi.fn(),
}

const finding: FindingListItem = {
  id: "finding-1",
  title: "Exposed secret",
  summary: "A secret was found in the repository.",
  severity: "HIGH",
  status: "OPEN",
  verified: false,
  verificationStatus: "DETECTED",
  confidence: "MEDIUM",
  target: { id: "target-1", name: "API", type: "REPO" },
  firstSeenAt: "2026-09-28T00:00:00.000Z",
  lastSeenAt: "2026-09-28T00:00:00.000Z",
  priority: { score: 90, band: "urgent", reasons: ["Release blocker"], limitations: [] },
}

describe("findings list view", () => {
  it("renders URL-derived scope, active filter, target and sort controls", () => {
    const html = renderToStaticMarkup(
      <FindingsControls
        filter="HIGH"
        sortMode="severity"
        scanId="scan-1"
        targetFilter="target-1"
        query="secret"
        targets={[{ id: "target-1", name: "API" }]}
        {...callbacks}
      />
    )

    expect(html).toContain("Target: API")
    expect(html).toContain("Scan: scan-1")
    expect(html).toMatch(/aria-pressed="true"[^>]*>High<\/button>/)
    expect(html).toContain('value="secret"')
    expect(html).toContain('aria-label="Sort loaded results"')
    expect(html).toContain('value="severity" selected=""')
    expect(html).toContain("disabled")
  })

  it("keeps loading and empty states distinct from paginated finding rows", () => {
    const rowRefs = { current: new Map<string, HTMLButtonElement | null>() }
    const onOpenFinding = vi.fn()
    const props = { rowRefs, onOpenFinding, sortedFindings: [] as FindingListItem[] }

    const loading = renderToStaticMarkup(
      <FindingsResults {...props} findings={[]} loading>
        <span>Load more</span>
      </FindingsResults>
    )
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain("Load more")

    const empty = renderToStaticMarkup(<FindingsResults {...props} findings={[]} loading={false} />)
    expect(empty).toContain("No findings yet")
    expect(empty).toContain("Start a scan")

    const populated = renderToStaticMarkup(
      <FindingsResults {...props} findings={[finding]} sortedFindings={[finding]} loading={false}>
        <span>Load more</span>
      </FindingsResults>
    )
    expect(populated).toContain("Exposed secret")
    expect(populated).toContain("Release blocker")
    expect(populated).toContain('aria-haspopup="dialog"')
    expect(populated).toContain("Load more")
  })
})
