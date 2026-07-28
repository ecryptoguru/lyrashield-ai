"use client"

import { useEffect, type ReactNode } from "react"

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key || typeof window === "undefined") return

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
          before_send: (event) => {
            if (!event) return null

            for (const property of ["$current_url", "$referrer", "$initial_referrer", "referrer"]) {
              const value = event.properties[property]
              if (typeof value === "string") {
                try {
                  const url = new URL(value)
                  event.properties[property] = `${url.origin}${url.pathname}`
                } catch {
                  // Leave non-URL values unchanged.
                }
              }
            }

            return event
          },
          loaded: (ph) => {
            const dnt = navigator.doNotTrack
            const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean })
              .globalPrivacyControl
            if (gpc === true || dnt === "1" || dnt === "yes") {
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
