import { renderToString } from "react-dom/server"
import { describe, expect, it } from "vitest"

import ReportVerificationPage, { metadata } from "./page"

describe("report verification page", () => {
  it("keeps the public verify page out of search indexes with no referrer", () => {
    expect(metadata.robots).toEqual({
      index: false,
      follow: false,
      noarchive: true,
      noimageindex: true,
    })
    expect(metadata.referrer).toBe("no-referrer")
  })

  it("explains what the page checks and server-renders the verification form", () => {
    const html = renderToString(<ReportVerificationPage />)

    expect(html).toContain("Verify a Launch Readiness Report")
    // Assert on contiguous phrases: renderToString splits sibling text nodes
    // with comment markers, so only unbroken runs survive as one string.
    expect(html).toContain("issued by LyraShield and has not been edited")
    expect(html).toContain("exposing the stored release identity")
    expect(html).toContain('name="reportChecksum"')
    expect(html).toContain('name="signature"')
    expect(html).toContain('name="sharedReportUrl"')
    expect(html).toContain('name="expectedIdentity"')
  })

  it("server-renders the form as a POST with submit disabled so no field reaches a URL", () => {
    const html = renderToString(<ReportVerificationPage />)

    expect(html).toContain('method="post"')
    expect(html).toContain("Loading…")
    expect(html).not.toContain("Verify report")
  })
})
