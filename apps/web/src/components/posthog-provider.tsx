"use client"

import { useEffect, type ReactNode } from "react"

const URL_PROPERTIES = ["$current_url", "$referrer", "$initial_referrer", "referrer"]
const PATH_PROPERTIES = ["$pathname", "$prev_pageview_pathname", "$prev_pageview_url"]

export function privacyBoundedPostHogEvent<T extends { properties: Record<string, unknown> }>(
  event: T
): T {
  for (const property of URL_PROPERTIES) {
    const value = event.properties[property]
    if (typeof value !== "string") continue
    try {
      event.properties[property] = new URL(value).origin
    } catch {
      delete event.properties[property]
    }
  }
  for (const property of PATH_PROPERTIES) delete event.properties[property]
  return event
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key || typeof window === "undefined") return
    const dnt = navigator.doNotTrack
    const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
    if (gpc === true || dnt === "1" || dnt === "yes") return

    // Avoid double init on hot reload.
    const win = window as unknown as { posthog?: { __loaded?: boolean } }
    if (win.posthog?.__loaded) return

    import("posthog-js")
      .then(({ default: posthog }) => {
        posthog.init(key, {
          api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
          ui_host: "https://us.posthog.com",
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: true,
          disable_scroll_properties: false,
          disable_session_recording: true,
          persistence: "localStorage",
          respect_dnt: true,
          before_send: (event) => (event ? privacyBoundedPostHogEvent(event) : null),
          loaded: (ph) => {
            const currentDnt = navigator.doNotTrack
            const currentGpc = (navigator as Navigator & { globalPrivacyControl?: boolean })
              .globalPrivacyControl
            if (currentGpc === true || currentDnt === "1" || currentDnt === "yes") {
              ph.opt_out_capturing()
            }
          },
        })

        ;(window as unknown as { posthog?: typeof posthog }).posthog = posthog
      })
      .catch(() => {
        // Silently skip analytics if posthog-js fails to load.
      })
  }, [])

  return <>{children}</>
}
