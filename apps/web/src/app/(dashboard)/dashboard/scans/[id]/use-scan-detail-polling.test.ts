import { describe, expect, it } from "vitest"
import { selectScanPollEtag } from "./use-scan-detail-polling"

describe("scan detail polling ETag commits", () => {
  it("retries terminal findings after a failed fetch before accepting the terminal ETag", () => {
    const activeEtag = '"active"'
    const terminalEtag = '"terminal"'

    // The server returns the terminal representation because the active ETag
    // is stale, but the associated findings request fails.
    const afterFailedFindings = selectScanPollEtag({
      currentEtag: activeEtag,
      responseEtag: terminalEtag,
      responseStatus: 200,
      responseProcessed: false,
    })

    expect(afterFailedFindings).toBe(activeEtag)
    expect(afterFailedFindings === terminalEtag ? 304 : 200).toBe(200)

    const afterSuccessfulRetry = selectScanPollEtag({
      currentEtag: afterFailedFindings,
      responseEtag: terminalEtag,
      responseStatus: 200,
      responseProcessed: true,
    })

    expect(afterSuccessfulRetry).toBe(terminalEtag)
    expect(afterSuccessfulRetry === terminalEtag ? 304 : 200).toBe(304)
  })
})
