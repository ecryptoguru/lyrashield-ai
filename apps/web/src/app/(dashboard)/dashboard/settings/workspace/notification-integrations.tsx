"use client"

import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { Bell, MessageSquare } from "lucide-react"
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@lyrashield/ui"
import { apiDelete, apiGet, apiPost } from "@/lib/api-client"

const integrationSchema = z.object({
  id: z.string(),
  channel: z.enum(["slack", "discord"]),
  name: z.string(),
  status: z.enum(["active", "disabled"]),
  updatedAt: z.string(),
})
const integrationsSchema = z.array(integrationSchema)
type Integration = z.infer<typeof integrationSchema>
type Channel = Integration["channel"]
type NotificationAction = "save" | "test" | "disconnect"
const channels = ["slack", "discord"] as const
const endpoint = "/api/integrations/notifications"

export function NotificationIntegrations(props: { workspaceId: string; canManage: boolean }) {
  // Switching workspace or permissions discards draft credentials and pending UI state.
  return (
    <NotificationIntegrationSettings key={`${props.workspaceId}:${props.canManage}`} {...props} />
  )
}

function NotificationIntegrationSettings({
  workspaceId,
  canManage,
}: {
  workspaceId: string
  canManage: boolean
}) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    apiGet(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      schema: integrationsSchema,
    })
      .then((data) => {
        if (!active) return
        setIntegrations(data)
        setError(false)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [workspaceId, attempt])

  function update(integration: Integration) {
    setIntegrations((previous) => [
      ...(previous ?? []).filter((item) => item.channel !== integration.channel),
      integration,
    ])
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <Bell className="size-4" aria-hidden="true" />
          Notification channels
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm leading-6">
          Receive scan completed, scan failed and critical finding alerts in Slack or Discord.
          Notifications share the workspace name, alert summary and related scan or finding IDs with
          everyone who can read the destination channel. Keep the destination private to your team.
        </p>
        <p className="text-muted-foreground text-sm">
          These webhooks send notifications only. They do not grant access to Slack or Discord
          messages, and are separate from coding-agent connections.
        </p>
        {!canManage && (
          <p className="text-muted-foreground text-sm">
            Only workspace owners and admins can manage these channels.
          </p>
        )}
        {error ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive text-sm">
              Unable to load notification channels. Try again.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setError(false)
                setAttempt((value) => value + 1)
              }}
            >
              Retry
            </Button>
          </div>
        ) : integrations === null ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading notification channels…
          </p>
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {channels.map((channel) => (
              <NotificationChannel
                key={channel}
                workspaceId={workspaceId}
                channel={channel}
                integration={integrations.find((item) => item.channel === channel)}
                canManage={canManage}
                onUpdate={update}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function NotificationChannel({
  workspaceId,
  channel,
  integration,
  canManage,
  onUpdate,
}: {
  workspaceId: string
  channel: Channel
  integration: Integration | undefined
  canManage: boolean
  onUpdate: (integration: Integration) => void
}) {
  const id = useId()
  const title = channel === "slack" ? "Slack" : "Discord"
  const connected = integration?.status === "active"
  const [editing, setEditing] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState("")
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [busy, setBusy] = useState<NotificationAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function perform(action: NotificationAction) {
    if (!canManage || pending.current || (action === "save" && !webhookUrl.trim())) return
    pending.current = true
    setBusy(action)
    setError(null)
    setNotice(null)
    const body = { workspaceId, channel }
    try {
      if (action === "test") {
        await apiPost(`${endpoint}/test`, body)
        if (mounted.current) setNotice("Test message sent. Check your destination channel.")
      } else {
        const updated =
          action === "save"
            ? await apiPost(
                endpoint,
                { ...body, webhookUrl: webhookUrl.trim() },
                { schema: integrationSchema }
              )
            : await apiDelete(endpoint, { body: JSON.stringify(body), schema: integrationSchema })
        if (!mounted.current) return
        onUpdate(updated)
        setWebhookUrl("")
        setEditing(false)
        setConfirmDisconnect(false)
        setNotice(
          action === "save"
            ? "Webhook saved. Send a test to confirm delivery."
            : "Channel disconnected. Reconnect with a webhook at any time."
        )
      }
    } catch {
      if (!mounted.current) return
      // Provider errors can contain a credential-bearing URL; never echo them.
      setError(
        action === "save"
          ? `Unable to save the webhook. Check the ${title} webhook URL and try again.`
          : action === "test"
            ? "Unable to send the test message. Check the webhook and try again."
            : "Unable to disconnect the channel. Try again."
      )
    } finally {
      pending.current = false
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="flex items-center gap-2 font-semibold">
          <MessageSquare className="size-4" aria-hidden="true" />
          {title} notifications
        </h3>
        <Badge variant={connected ? "success" : "muted"}>
          {connected ? "Connected" : integration ? "Disconnected" : "Not connected"}
        </Badge>
      </div>
      <p className="text-muted-foreground text-sm leading-6">
        {channel === "slack"
          ? "Create a Slack app with Incoming Webhooks enabled, choose a channel and paste its webhook URL below."
          : "In your Discord server, open channel settings → Integrations → Webhooks, then copy the webhook URL."}
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      )}
      {canManage && (!connected || editing) && (
        <WebhookForm
          id={id}
          title={title}
          connected={connected}
          busy={busy}
          editing={editing}
          webhookUrl={webhookUrl}
          onChange={setWebhookUrl}
          onSave={() => void perform("save")}
          onCancel={() => {
            setEditing(false)
            setWebhookUrl("")
            setError(null)
          }}
        />
      )}
      {canManage && connected && !editing && (
        <ConnectedChannelActions
          title={title}
          busy={busy}
          confirmDisconnect={confirmDisconnect}
          onTest={() => void perform("test")}
          onConfirmDisconnect={() => void perform("disconnect")}
          onKeepConnected={() => setConfirmDisconnect(false)}
          onEdit={() => {
            setEditing(true)
            setError(null)
            setNotice(null)
          }}
          onDisconnect={() => {
            setConfirmDisconnect(true)
            setError(null)
            setNotice(null)
          }}
        />
      )}
    </section>
  )
}

function WebhookForm({
  id,
  title,
  connected,
  busy,
  editing,
  webhookUrl,
  onChange,
  onSave,
  onCancel,
}: {
  id: string
  title: string
  connected: boolean
  busy: NotificationAction | null
  editing: boolean
  webhookUrl: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="space-y-2">
        <label htmlFor={`${id}-webhook`} className="text-sm font-medium">
          {title} webhook URL
        </label>
        <Input
          id={`${id}-webhook`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={webhookUrl}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy !== null}
          maxLength={2048}
          required
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-muted-foreground text-xs leading-5">
          Stored securely. Saved webhook URLs are never shown again. Saving does not send a test
          message.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== null || !webhookUrl.trim()}>
          {busy === "save" ? "Saving…" : connected ? "Save webhook" : `Connect ${title}`}
        </Button>
        {editing && (
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

function ConnectedChannelActions({
  title,
  busy,
  confirmDisconnect,
  onTest,
  onEdit,
  onDisconnect,
  onConfirmDisconnect,
  onKeepConnected,
}: {
  title: string
  busy: NotificationAction | null
  confirmDisconnect: boolean
  onTest: () => void
  onEdit: () => void
  onDisconnect: () => void
  onConfirmDisconnect: () => void
  onKeepConnected: () => void
}) {
  if (confirmDisconnect) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Stop sending notifications to this {title} channel?</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" disabled={busy !== null} onClick={onConfirmDisconnect}>
            {busy === "disconnect" ? "Disconnecting…" : "Confirm disconnect"}
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={onKeepConnected}>
            Keep connected
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy !== null} onClick={onTest}>
        {busy === "test" ? "Sending…" : "Send test"}
      </Button>
      <Button variant="outline" disabled={busy !== null} onClick={onEdit}>
        Update webhook
      </Button>
      <Button variant="ghost" disabled={busy !== null} onClick={onDisconnect}>
        Disconnect
      </Button>
    </div>
  )
}
