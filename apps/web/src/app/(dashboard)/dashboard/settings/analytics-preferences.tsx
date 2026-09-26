"use client"

import { useCallback, useEffect, useState } from "react"
import { z } from "zod"
import { Card, CardContent, CardHeader, CardTitle, Switch, Button, Spinner } from "@lyrashield/ui"
import { apiGet, apiPatch } from "@/lib/api-client"
import {
  analyticsCookiePreference,
  analyticsOptedOut,
  clearOptionalTrackingCookiesInBrowser,
  setAnalyticsPreference,
  writeAnalyticsPreferenceCookie,
} from "@/lib/analytics"

interface Preference {
  analyticsEnabled: boolean
}
const preferenceSchema = z.object({ analyticsEnabled: z.boolean() })

export function AnalyticsPreferences() {
  const [enabled, setEnabled] = useState(false)
  const [accountEnabled, setAccountEnabled] = useState(true)
  const [browserEnabled, setBrowserEnabled] = useState(true)
  const [privacySignalOff, setPrivacySignalOff] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorAction, setErrorAction] = useState<"load" | "save">("load")
  const [retryValue, setRetryValue] = useState(false)

  const load = useCallback(async () => {
    try {
      const preference = await apiGet("/api/account/preferences", { schema: preferenceSchema })
      const browserPreference = analyticsCookiePreference(document.cookie) !== "off"
      const next = preference.analyticsEnabled && browserPreference
      setAccountEnabled(preference.analyticsEnabled)
      setBrowserEnabled(browserPreference)
      setEnabled(next)
      setPrivacySignalOff(
        analyticsOptedOut(
          navigator.doNotTrack,
          (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
        )
      )
      setAnalyticsPreference(next)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load analytics setting")
      setErrorAction("load")
      setAnalyticsPreference(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  function retryLoad() {
    setLoading(true)
    setError(null)
    void load()
  }

  async function update(next: boolean) {
    setSaving(true)
    setError(null)
    setRetryValue(next)
    if (!next) {
      setEnabled(false)
      setBrowserEnabled(false)
      writeAnalyticsPreferenceCookie(false)
      clearOptionalTrackingCookiesInBrowser()
      setAnalyticsPreference(false)
    }
    try {
      await apiPatch<Preference>("/api/account/preferences", { analyticsEnabled: next })
      setAccountEnabled(next)
      setBrowserEnabled(next)
      setEnabled(next)
      writeAnalyticsPreferenceCookie(next)
      setAnalyticsPreference(next)
    } catch (saveError) {
      if (next) {
        setEnabled(false)
        setBrowserEnabled(false)
        writeAnalyticsPreferenceCookie(false)
        clearOptionalTrackingCookiesInBrowser()
        setAnalyticsPreference(false)
      }
      setError(saveError instanceof Error ? saveError.message : "Unable to save analytics setting")
      setErrorAction("save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Optional analytics</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm leading-6">
          Help improve LyraShield with privacy-bounded usage events. Analytics is on by default.
          This account setting follows you across devices; this browser preference is also shared
          with the marketing site. Do Not Track and Global Privacy Control always stop optional
          collection.
        </p>
        {error && (
          <div role="alert" className="space-y-2">
            <p className="text-destructive text-sm">{error}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void (errorAction === "save" ? update(retryValue) : retryLoad())}
            >
              {errorAction === "save" ? "Retry save" : "Retry"}
            </Button>
          </div>
        )}
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Spinner className="size-4" /> Loading preference…
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div>
              <p className="font-medium">Allow optional usage analytics</p>
              <p className="text-muted-foreground text-sm" aria-live="polite">
                {saving
                  ? "Saving…"
                  : privacySignalOff
                    ? "Blocked by your browser’s Do Not Track or Global Privacy Control signal."
                    : enabled
                      ? "Enabled for this account and browser."
                      : !accountEnabled && !browserEnabled
                        ? "Disabled for this account and browser."
                        : !accountEnabled
                          ? "Disabled for this account across devices."
                          : "Disabled in this browser."}
              </p>
            </div>
            <Switch
              checked={enabled && !privacySignalOff}
              disabled={saving || privacySignalOff}
              aria-label="Allow optional usage analytics"
              onCheckedChange={(checked) => void update(checked)}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
