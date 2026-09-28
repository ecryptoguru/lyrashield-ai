import { readFileSync } from "node:fs"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FindingStatusBadge } from "./finding-detail-drawer"

// The drawer's verification and receipt badges sit behind fetched detail state
// that SSR cannot reach; pin the label wiring at the source so the humanised
// helpers cannot regress back to raw token replaces.
const source = readFileSync(new URL("./finding-detail-drawer.tsx", import.meta.url), "utf8")
const tabsSource = readFileSync(new URL("./finding-detail-tabs.tsx", import.meta.url), "utf8")

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
    expect(source).toContain("FINDING_STATUS_LABELS[finding.status]")
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
