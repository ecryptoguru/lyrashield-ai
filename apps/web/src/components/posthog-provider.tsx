"use client"

import { useEffect, type ReactNode } from "react"
import {
  ANALYTICS_PREFERENCE_EVENT,
  analyticsCollectionAllowed,
  flushQueuedAnalytics,
  resolveAnalyticsPreference,
} from "@/lib/analytics"

const URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_referrer",
  "referrer",
]
const PATH_PROPERTIES = [
  "$pathname",
  "$prev_pageview_pathname",
  "$prev_pageview_url",
  "$session_entry_pathname",
]

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
    if (!key) return

    let active = true
    let importing = false
    const initialize = async () => {
      if (!active || !analyticsCollectionAllowed() || importing) return
      const win = window as unknown as {
        posthog?: {
          __loaded?: boolean
          opt_in_capturing?: () => void
          opt_out_capturing?: () => void
        }
      }
      if (win.posthog?.__loaded) {
        win.posthog.opt_in_capturing?.()
        flushQueuedAnalytics((event, properties) => {
          ;(win.posthog as typeof import("posthog-js").default).capture(event, properties)
        })
        return
      }

      importing = true
      try {
        const { default: posthog } = await import("posthog-js")
        if (!active || !analyticsCollectionAllowed()) return
        if (!posthog.__loaded) {
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
            before_send: (event) =>
              event && analyticsCollectionAllowed() ? privacyBoundedPostHogEvent(event) : null,
            loaded: (ph) => {
              if (!analyticsCollectionAllowed()) {
                ph.opt_out_capturing()
                flushQueuedAnalytics()
                return
              }
              ph.opt_in_capturing()
              flushQueuedAnalytics((event, properties) => ph.capture(event, properties))
            },
          })
        } else {
          posthog.opt_in_capturing()
        }
        ;(window as unknown as { posthog?: typeof posthog }).posthog = posthog
      } catch {
        // Silently skip analytics if posthog-js fails to load.
      } finally {
        importing = false
      }
    }

    const synchronize = () => {
      const posthog = (window as unknown as { posthog?: typeof import("posthog-js").default })
        .posthog
      if (!analyticsCollectionAllowed()) {
        posthog?.opt_out_capturing()
        flushQueuedAnalytics()
      } else {
        void initialize()
      }
    }

    window.addEventListener(ANALYTICS_PREFERENCE_EVENT, synchronize)
    void resolveAnalyticsPreference().then(synchronize)
    return () => {
      active = false
      window.removeEventListener(ANALYTICS_PREFERENCE_EVENT, synchronize)
    }
  }, [])

  return <>{children}</>
}
