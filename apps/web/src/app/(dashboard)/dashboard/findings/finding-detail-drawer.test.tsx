import { readFileSync } from "node:fs"
import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FindingStatusBadge } from "./finding-detail-drawer"

// The drawer's verification and receipt badges sit behind fetched detail state
// that SSR cannot reach; pin the label wiring at the source so the humanised
// helpers cannot regress back to raw token replaces.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("./finding-detail-drawer.tsx", import.meta.url), "utf8")

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
    expect(source).toContain("FINDING_STATUS_LABELS[finding.status]")
    expect(source).toContain("getVerificationStatusLabel(finding.verificationStatus)")
    expect(source).toContain("getVerificationStatusLabel(receipt.status)")
    expect(source).toContain("humanizeToken(receipt.method)")
  })
})
