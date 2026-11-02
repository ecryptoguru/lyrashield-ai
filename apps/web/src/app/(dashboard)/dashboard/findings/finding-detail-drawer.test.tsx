import { readFileSync } from "node:fs"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FindingStatusBadge, type FindingDetail } from "./finding-detail-drawer"
import { FindingTechnicalTab } from "./finding-detail-tabs"
import { Tabs } from "@/components/ui/tabs"

// The drawer's verification and receipt badges sit behind fetched detail state
// that SSR cannot reach; pin the label wiring at the source so the humanised
// helpers cannot regress back to raw token replaces.
const source = readFileSync(new URL("./finding-detail-drawer.tsx", import.meta.url), "utf8")
const tabsSource = readFileSync(new URL("./finding-detail-tabs.tsx", import.meta.url), "utf8")
const actionSource = readFileSync(new URL("./finding-action-tab.tsx", import.meta.url), "utf8")

describe("FindingStatusBadge", () => {
  it("labels FIX_READY as a human phrase not a raw token", () => {
    const html = renderToString(<FindingStatusBadge status="FIX_READY" />)
    expect(html).toContain(">Fix ready<")
    expect(html).not.toContain("FIX READY")
    expect(html).not.toContain("FIX_READY")
  })
})

describe("finding detail drawer enum labels", () => {
  it("routes every status and method badge through the label helpers", () => {
    expect(source).not.toContain('replace(/_/g, " ")')
    expect(source).not.toContain('replaceAll("_", " ")')
    expect(tabsSource).not.toContain('replace(/_/g, " ")')
    expect(tabsSource).not.toContain('replaceAll("_", " ")')
    expect(actionSource).not.toContain('replace(/_/g, " ")')
    expect(actionSource).not.toContain('replaceAll("_", " ")')
    expect(actionSource).toContain("FINDING_STATUS_LABELS[finding.status]")
    expect(source).toContain("getVerificationStatusLabel(finding.verificationStatus)")
    expect(tabsSource).toContain("getVerificationStatusLabel(receipt.status)")
    expect(tabsSource).toContain("humanizeToken(receipt.method)")
  })

  it("lets long checksums and receipt ids wrap instead of overflowing", () => {
    expect((tabsSource.match(/className="break-all font-mono"/g) ?? []).length).toBe(7)
    // Only the short scanner-source label keeps plain mono styling.
    expect((tabsSource.match(/className="font-mono"/g) ?? []).length).toBe(1)
  })
})

describe("pending HTTP evidence display", () => {
  it("renders unresolved IDs with an explicit pending label and trust boundary", () => {
    const detail: FindingDetail = {
      id: "f",
      title: "Claim",
      summary: "Pending exchange evidence",
      evidenceInsights: {
        pendingHttpExchangeIds: ["1".repeat(128), "42"],
        pendingHttpExchangeState: "PENDING",
        evidenceObservationScanId: "scan-1",
      },
    }
    const html = renderToString(
      <Tabs value="technical">
        <FindingTechnicalTab
          detail={detail}
          knownExploited={false}
          epssSummary={undefined}
          historyLoading={new Set()}
          loadMoreHistory={async () => {}}
        />
      </Tabs>
    )
    expect(html).toContain(">Pending<")
    expect(html).toContain("Evidence from scan ")
    expect(html).toContain("scan-1")
    expect(html).toContain("Exchange claims await bound evidence. They do not verify this finding.")
    expect(html).toContain("1".repeat(128))
    expect(html).toContain("break-all font-mono")
    expect(html).not.toContain(">Verified<")
  })
})
