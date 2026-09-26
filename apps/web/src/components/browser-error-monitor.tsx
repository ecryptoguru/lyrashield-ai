"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ANALYTICS_PREFERENCE_EVENT,
  analyticsPermissionAllowsOptionalCollection,
  resolveAnalyticsPreference,
} from "@/lib/analytics"
import { createBrowserErrorMonitor } from "@/lib/browser-error-monitor"

function isAnalyticsPreference(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean"
}

/** Resolves optional collection permission before the browser SDK can load. */
export function BrowserErrorMonitorGate() {
  const [optionalCollectionEnabled, setOptionalCollectionEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    let preferenceChanged = false

    const synchronize = (preference: boolean | null) => {
      if (!active) return
      setOptionalCollectionEnabled(
        preference === true && !analyticsPermissionAllowsOptionalCollection() ? false : preference
      )
    }

    const onPreferenceChange = (event: Event) => {
      preferenceChanged = true
      const preference = (event as CustomEvent<unknown>).detail
      synchronize(isAnalyticsPreference(preference) ? preference : null)
    }

    window.addEventListener(ANALYTICS_PREFERENCE_EVENT, onPreferenceChange)
    void resolveAnalyticsPreference()
      .then((preference) => {
        // A newer explicit preference event must win over a stale request.
        if (active && !preferenceChanged) synchronize(preference)
      })
      .catch(() => {
        if (active && !preferenceChanged) synchronize(null)
      })

    return () => {
      active = false
      window.removeEventListener(ANALYTICS_PREFERENCE_EVENT, onPreferenceChange)
    }
  }, [])

  return <BrowserErrorMonitor optionalCollectionEnabled={optionalCollectionEnabled} />
}

export function BrowserErrorMonitor({
  optionalCollectionEnabled,
}: {
  optionalCollectionEnabled: boolean | null
}) {
  const monitor = useMemo(() => createBrowserErrorMonitor(), [])

  useEffect(() => {
    void monitor.setCollectionAllowed(optionalCollectionEnabled)
  }, [monitor, optionalCollectionEnabled])

  return null
}
