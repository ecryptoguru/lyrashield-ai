/**
 * Poll-scheduling arithmetic for the scan detail page.
 *
 * Kept free of React so the back-off behaviour can be pinned with a stable
 * clock instead of a hook stub. `use-scan-detail-polling.ts` re-exports both
 * helpers, so existing importers are unaffected.
 */

/** Poll cadence from elapsed time: 5s, then 10s, then 60s. */
export function nextScanDetailPollInterval(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5_000
  if (elapsedMs < 5 * 60_000) return 10_000
  return 60_000
}

/**
 * The back-off clock for the scan detail poll loop.
 *
 * `startedAt` is null while a scan is QUEUED or REQUIRES_APPROVAL — exactly the
 * states that poll longest. Falling back to `Date.now()` at each tick reset the
 * clock to zero every time, so `elapsedMs` was always about 0 and the interval
 * stayed at 5s for the whole wait (P2-14). Anchoring on the scan's own start
 * when it has one and on the moment the loop began when it does not lets
 * elapsed time actually advance. A visible-tab resume returns 0 so state
 * catches up immediately rather than waiting out the interval.
 */
export function scanDetailPollDelay({
  startedAt,
  anchorMs,
  nowMs,
  refreshOnVisible,
}: {
  startedAt: string | null
  anchorMs: number
  nowMs: number
  refreshOnVisible: boolean
}): number {
  if (refreshOnVisible) return 0
  const startedAtMs = startedAt ? new Date(startedAt).getTime() : anchorMs
  return nextScanDetailPollInterval(nowMs - startedAtMs)
}
