"use client"

import { useState, useEffect, useCallback } from "react"
import { Bell, AlertCircle, CheckCircle2, Mail, MessageSquare } from "lucide-react"
import { Button, Badge, type BadgeProps, Card, EmptyState, Spinner, LoadMore } from "@lyrashield/ui"
import { apiGetPaginated, apiPatch } from "@/lib/api-client"

interface NotificationItem {
  id: string
  channel: string
  type: string
  title: string
  body: string
  status: string
  sentAt: string | null
  createdAt: string
}

const CHANNEL_ICONS: Record<string, typeof Bell> = {
  email: Mail,
  slack: MessageSquare,
  discord: MessageSquare,
  in_app: Bell,
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>

const TYPE_COLORS: Record<string, BadgeVariant> = {
  "scan.completed": "success",
  "scan.failed": "danger",
  "finding.critical": "danger",
  "fix.pr_created": "info",
}

export function NotificationsClient({ workspaceId }: { workspaceId: string }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGetPaginated<NotificationItem>(`/api/notifications`, { workspaceId })
      setNotifications(res.items)
      setNextCursor(res.nextCursor)
      setError(null)
    } catch {
      setNotifications([])
      setError("Failed to load notifications.")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    apiGetPaginated<NotificationItem>(`/api/notifications`, { workspaceId })
      .then((res) => {
        if (cancelled) return
        setNotifications(res.items)
        setNextCursor(res.nextCursor)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError("Failed to load notifications.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId])

  const handleMarkRead = async (notificationId: string) => {
    try {
      await apiPatch(`/api/notifications/${notificationId}`, {
        workspaceId,
        action: "mark_read",
      })
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, status: "read" } : n))
      )
    } catch {
      setError("Failed to mark notification as read.")
    }
  }

  const handleMarkAllRead = async () => {
    const unread = notifications.filter((n) => n.status !== "read")
    if (unread.length === 0) return
    try {
      await Promise.all(
        unread.map((n) =>
          apiPatch(`/api/notifications/${n.id}`, { workspaceId, action: "mark_read" })
        )
      )
      setNotifications((prev) => prev.map((n) => ({ ...n, status: "read" })))
    } catch {
      setError("Failed to mark all notifications as read.")
    }
  }

  if (loading && notifications.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-sm text-muted-foreground">Loading notifications...</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">Scan alerts, finding warnings, and fix PR updates</p>
        </div>
        {notifications.some((n) => n.status !== "read") && (
          <Button size="sm" variant="ghost" onClick={() => void handleMarkAllRead()}>
            <CheckCircle2 className="h-4 w-4 mr-1" aria-hidden="true" />
            Mark all as read
          </Button>
        )}
      </div>

      {error && (
        <Card className="mb-4 p-4 border-destructive/50">
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setError(null); void loadNotifications() }}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications"
          description="You'll see scan alerts, critical finding warnings, and fix PR updates here."
        />
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const Icon = CHANNEL_ICONS[notification.channel] ?? Bell
            const badgeVariant = TYPE_COLORS[notification.type] ?? "muted"
            return (
              <Card key={notification.id} className="p-4 transition-shadow duration-200 hover:shadow-card-hover">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium truncate">{notification.title}</h3>
                      <Badge variant={badgeVariant}>{notification.type}</Badge>
                      {notification.status === "read" && (
                        <Badge variant="muted">read</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-line">
                      {notification.body}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      {new Date(notification.createdAt).toLocaleString()}
                      {notification.sentAt && (
                        <> · Sent {new Date(notification.sentAt).toLocaleString()}</>
                      )}
                    </p>
                  </div>
                  {notification.status !== "read" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Mark as read"
                      onClick={() => void handleMarkRead(notification.id)}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<NotificationItem>(
                `/api/notifications`, { workspaceId, cursor }
              )
              return { items: res.items as unknown[], nextCursor: res.nextCursor }
            }}
            onItems={(items) => setNotifications((prev) => [...prev, ...(items as NotificationItem[])])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
