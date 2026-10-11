"use client"

import { useId } from "react"
import { Bell, Mail, Smartphone } from "lucide-react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, Switch } from "@lyrashield/ui"

export function NotificationPreferences() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-5" aria-hidden="true" />
          Personal notification preferences
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Personal email and in-app preferences are not available yet. Your stored choices are
          retained for a future release.
        </p>
        <p className="text-muted-foreground text-sm">
          Scan updates appear in the dashboard. Workspace owners and admins can configure Slack or
          Discord notifications in{" "}
          <Link
            href="/dashboard/settings/workspace#notification-channels"
            className="text-primary font-medium underline underline-offset-4"
          >
            Workspace settings
          </Link>
          . These workspace notifications are not controlled by the switches below.
        </p>

        <div className="space-y-3">
          <PreferenceRow
            icon={Mail}
            title="Email notifications"
            description="Unavailable. Your stored choice is retained for a future release."
            checked={false}
            disabled
          />
          <PreferenceRow
            icon={Bell}
            title="In-app notifications"
            description="Unavailable. Your stored choice is retained for a future release."
            checked={false}
            disabled
          />
          <PreferenceRow
            icon={Smartphone}
            title="Push notifications"
            description="Unavailable."
            checked={false}
            disabled
          />
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
  disabled,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  description: string
  checked: boolean
  disabled: boolean
}) {
  const baseId = useId()
  const labelId = `${baseId}-label`
  const descId = `${baseId}-desc`

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Icon className="text-primary mt-0.5 size-5" aria-hidden={true} />
        <div>
          <p id={labelId} className="font-medium">
            {title}
          </p>
          <p id={descId} className="text-muted-foreground text-sm">
            {description}
          </p>
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descId}
      />
    </div>
  )
}
