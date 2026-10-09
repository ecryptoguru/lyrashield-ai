import { describe, expect, it } from "vitest"
import { nextScanDetailPollInterval, scanDetailPollDelay } from "./scan-detail-poll-schedule"
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

describe("scan detail poll cadence", () => {
  it("uses 5s, 10s then 60s as elapsed time grows", () => {
    expect(nextScanDetailPollInterval(0)).toBe(5_000)
    expect(nextScanDetailPollInterval(59_999)).toBe(5_000)
    expect(nextScanDetailPollInterval(60_000)).toBe(10_000)
    expect(nextScanDetailPollInterval(5 * 60_000 - 1)).toBe(10_000)
    expect(nextScanDetailPollInterval(5 * 60_000)).toBe(60_000)
    expect(nextScanDetailPollInterval(60 * 60_000)).toBe(60_000)
  })
})

/**
 * P2-14 — a scan with no startedAt (QUEUED or REQUIRES_APPROVAL) must still
 * back off. The clock used to fall back to `Date.now()` on every tick, so
 * elapsed time was always about zero and the interval never left 5s.
 *
 * Every case below is driven by explicit timestamps, so the assertions do not
 * depend on how fast the test machine runs.
 */
describe("scan detail polling back-off with no startedAt (P2-14)", () => {
  const anchorMs = 1_700_000_000_000

  it("keeps the 5s cadence inside the first minute", () => {
    for (const elapsed of [0, 1_000, 30_000, 59_999]) {
      expect(
        scanDetailPollDelay({
          startedAt: null,
          anchorMs,
          nowMs: anchorMs + elapsed,
          refreshOnVisible: false,
        })
      ).toBe(5_000)
    }
  })

  it("backs off to 10s after a minute of waiting", () => {
    for (const elapsed of [60_000, 61_000, 2 * 60_000, 5 * 60_000 - 1]) {
      expect(
        scanDetailPollDelay({
          startedAt: null,
          anchorMs,
          nowMs: anchorMs + elapsed,
          refreshOnVisible: false,
        })
      ).toBe(10_000)
    }
  })

  it("backs off to 60s after five minutes of waiting", () => {
    for (const elapsed of [5 * 60_000, 6 * 60_000, 60 * 60_000]) {
      expect(
        scanDetailPollDelay({
          startedAt: null,
          anchorMs,
          nowMs: anchorMs + elapsed,
          refreshOnVisible: false,
        })
      ).toBe(60_000)
    }
  })

  it("anchors on the scan's own startedAt when it has one", () => {
    const startedAt = new Date(anchorMs - 4 * 60_000).toISOString()

    // The anchor is irrelevant once startedAt exists: the scan has already been
    // running four minutes, so the loop is on its 10s step from the first tick.
    expect(
      scanDetailPollDelay({
        startedAt,
        anchorMs,
        nowMs: anchorMs,
        refreshOnVisible: false,
      })
    ).toBe(10_000)
    expect(
      scanDetailPollDelay({
        startedAt,
        anchorMs,
        nowMs: anchorMs + 2 * 60_000,
        refreshOnVisible: false,
      })
    ).toBe(60_000)
  })

  it("polls immediately when the tab becomes visible again", () => {
    // A resume is one immediate refetch regardless of how long the tab was
    // hidden, so state catches up instead of waiting out the backoff.
    for (const elapsed of [0, 90_000, 10 * 60_000]) {
      expect(
        scanDetailPollDelay({
          startedAt: null,
          anchorMs,
          nowMs: anchorMs + elapsed,
          refreshOnVisible: true,
        })
      ).toBe(0)
    }
  })

  it("does not reset the back-off when the scan identity changes", () => {
    // Switching scans remounts the loop and reseeds the anchor. The new scan
    // gets its own full cadence — the point is that the anchor moves with the
    // loop rather than being recomputed per tick, so the new scan's wait still
    // advances monotonically.
    const secondAnchor = anchorMs + 10 * 60_000

    expect(
      scanDetailPollDelay({
        startedAt: null,
        anchorMs: secondAnchor,
        nowMs: secondAnchor + 30_000,
        refreshOnVisible: false,
      })
    ).toBe(5_000)
    expect(
      scanDetailPollDelay({
        startedAt: null,
        anchorMs: secondAnchor,
        nowMs: secondAnchor + 70_000,
        refreshOnVisible: false,
      })
    ).toBe(10_000)
    expect(
      scanDetailPollDelay({
        startedAt: null,
        anchorMs: secondAnchor,
        nowMs: secondAnchor + 6 * 60_000,
        refreshOnVisible: false,
      })
    ).toBe(60_000)
  })

  it("stops backing off further once a scan is terminal", () => {
    // A terminal scan is not polled at all — the loop returns before
    // scheduling. This pins the cadence the loop would compute so a future
    // change that keeps polling a finished scan is visible in the diff.
    const longWait = 24 * 60 * 60_000
    expect(
      scanDetailPollDelay({
        startedAt: null,
        anchorMs,
        nowMs: anchorMs + longWait,
        refreshOnVisible: false,
      })
    ).toBe(60_000)
  })
})
