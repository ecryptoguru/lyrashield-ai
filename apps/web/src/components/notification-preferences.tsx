"use client"

import { useEffect, useState } from "react"
import { z } from "zod"
import { Bell, Mail, Smartphone } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Switch } from "@lyrashield/ui"
import { apiGet, apiPatch } from "@/lib/api-client"
import { track } from "@/lib/analytics"

interface NotificationPreference {
  id: string
  userId: string
  emailDigest: boolean
  emailInstant: boolean
  inAppInstant: boolean
  inAppDigest: boolean
  pushEnabled: boolean
  quietHoursStart: number | null
  quietHoursEnd: number | null
}

const notificationPreferenceSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    emailDigest: z.boolean(),
    emailInstant: z.boolean(),
    inAppInstant: z.boolean(),
    inAppDigest: z.boolean(),
    pushEnabled: z.boolean(),
    quietHoursStart: z.number().nullable(),
    quietHoursEnd: z.number().nullable(),
  })
  .passthrough()

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<NotificationPreference | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiGet("/api/notifications/preferences", { schema: notificationPreferenceSchema })
      .then(setPrefs)
      .finally(() => setLoading(false))
  }, [])

  async function update(updates: Partial<NotificationPreference>) {
    if (!prefs) return
    const next = { ...prefs, ...updates }
    setPrefs(next)
    setSaving(true)
    try {
      const saved = await apiPatch(
        "/api/notifications/preferences",
        updates,
        { schema: notificationPreferenceSchema }
      )
      setPrefs(saved)
      track("notification_opened", { event_type: "preferences_updated" })
    } catch {
      setPrefs(prefs)
    } finally {
      setSaving(false)
    }
  }

  if (loading || !prefs) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground text-sm">Loading preferences…</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-5" aria-hidden="true" />
          Notification preferences
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Choose how you want to be notified. Push notifications are deferred for a future release.
        </p>

        <div className="space-y-3">
          <PreferenceRow
            icon={Mail}
            title="Email notifications"
            description="Daily digest and important instant alerts."
            checked={prefs.emailInstant && prefs.emailDigest}
            onChange={(checked) => update({ emailInstant: checked, emailDigest: checked })}
          />
          <PreferenceRow
            icon={Bell}
            title="In-app notifications"
            description="Instant and digest updates inside the dashboard."
            checked={prefs.inAppInstant && prefs.inAppDigest}
            onChange={(checked) => update({ inAppInstant: checked, inAppDigest: checked })}
          />
          <PreferenceRow
            icon={Smartphone}
            title="Push notifications"
            description="Mobile push alerts. (Coming soon)"
            checked={false}
            onChange={() => {}}
            disabled
          />
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <span className="text-sm font-medium">
            {saving ? "Saving…" : "Changes saved automatically"}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function PreferenceRow({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Icon className="text-primary mt-0.5 size-5" aria-hidden={true} />
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}
