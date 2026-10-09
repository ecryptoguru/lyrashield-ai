"use client"

import { useEffect } from "react"

/** Under a minute poll every 5s, under five minutes every 10s, then every 60s. */
function nextInterval(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5_000
  if (elapsedMs < 5 * 60_000) return 10_000
  return 60_000
}

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
          const startedAtMs = startedAt ? new Date(startedAt).getTime() : Date.now()
          const delay = refreshOnVisible ? 0 : nextInterval(Date.now() - startedAtMs)
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
