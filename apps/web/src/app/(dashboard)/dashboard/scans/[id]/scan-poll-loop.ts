"use client"

import { useEffect } from "react"
import { scanDetailPollDelay } from "./scan-detail-poll-schedule"

/**
 * The visibility-aware poll loop of the scan detail page. It was inline in
 * useScanDetailPolling and moved here unchanged so that hook stays inside the
 * size ratchet. Battery/network behaviour is the same: while the tab is hidden
 * the loop suspends entirely — no timer spin and no fetches — and one immediate
 * refetch runs when the tab becomes visible again.
 */
export function useScanPollLoop({
  isActive,
  startedAt,
  runRefresh,
  abortActiveRequest,
}: {
  isActive: boolean
  startedAt: string | null
  runRefresh: () => Promise<void> | void
  abortActiveRequest: () => void
}) {
  useEffect(() => {
    if (!isActive) return
    // SSR safety: the polling loop touches `document`; never assume a DOM.
    if (typeof document === "undefined") return
    let timeoutId: number | undefined
    let isAborted = false
    let inFlight = false
    let refreshOnVisible = false
    // P2-14: the back-off clock's fallback. Seeded once when this loop starts —
    // for a scan with no startedAt (QUEUED or REQUIRES_APPROVAL) — so elapsed
    // time advances instead of being recomputed as ~0 on every tick.
    const pollAnchorMs = Date.now()

    const schedule = (delayMs: number) => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      timeoutId = undefined
      if (!isAborted && !document.hidden) timeoutId = window.setTimeout(poll, delayMs)
    }

    const poll = async () => {
      timeoutId = undefined
      if (isAborted || document.hidden || inFlight) return
      inFlight = true
      try {
        await runRefresh()
      } finally {
        inFlight = false
        if (!isAborted && !document.hidden) {
          const delay = scanDetailPollDelay({
            startedAt,
            anchorMs: pollAnchorMs,
            nowMs: Date.now(),
            refreshOnVisible,
          })
          refreshOnVisible = false
          schedule(delay)
        }
      }
    }

    schedule(5_000)

    const onVisibility = () => {
      if (document.hidden) {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        timeoutId = undefined
        refreshOnVisible = false
      } else if (isActive && !isAborted) {
        if (inFlight) refreshOnVisible = true
        else schedule(0)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      isAborted = true
      abortActiveRequest()
      document.removeEventListener("visibilitychange", onVisibility)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [isActive, runRefresh, startedAt, abortActiveRequest])
}
