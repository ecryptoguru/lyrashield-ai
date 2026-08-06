"use client"

import { useState, useEffect, useCallback } from "react"
import { Bell, AlertCircle, CheckCircle2, Mail, MessageSquare } from "lucide-react"
import { Button, Badge, type BadgeProps, Card, EmptyState, LoadMore } from "@lyrashield/ui"
import { PageHeader } from "@/components/page-header"
import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { apiGetPaginated, apiPatch } from "@/lib/api-client"
import { formatDateTime } from "@/lib/date-format"
import { Skeleton } from "@/components/ui/skeleton"

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

const notificationItemSchema = z
  .object({
    id: z.string(),
    channel: z.string(),
    type: z.string(),
    title: z.string(),
    body: z.string(),
    status: z.string(),
    sentAt: z.string().datetime().or(z.string()).nullable(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const notificationsPaginatedSchema = paginatedResponseSchema(notificationItemSchema)

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

  const fetchNotifications = useCallback(async () => {
    return apiGetPaginated<NotificationItem>(
      `/api/notifications`,
      { workspaceId },
      { schema: notificationsPaginatedSchema }
    )
  }, [workspaceId])

  const loadNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchNotifications()
      setNotifications(res.items)
      setNextCursor(res.nextCursor)
      setError(null)
    } catch {
      setNotifications([])
      setError("Failed to load notifications.")
    } finally {
      setLoading(false)
    }
  }, [fetchNotifications])

  useEffect(() => {
    let cancelled = false
    fetchNotifications()
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
    return () => {
      cancelled = true
    }
  }, [fetchNotifications])

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
    if (!notifications.some((n) => n.status !== "read")) return
    try {
      await apiPatch(`/api/notifications`, { workspaceId, action: "mark_all_read" })
      setNotifications((prev) => prev.map((n) => ({ ...n, status: "read" })))
    } catch {
      setError("Failed to mark all notifications as read.")
    }
  }

  const markAllReadAction = notifications.some((n) => n.status !== "read") ? (
    <Button size="sm" variant="ghost" onClick={() => void handleMarkAllRead()}>
      <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />
      Mark all as read
    </Button>
  ) : null

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Scan alerts, finding warnings, and fix PR updates"
        action={markAllReadAction}
      />

      {error && (
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setError(null)
                void loadNotifications()
              }}
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {loading && notifications.length === 0 ? (
        <div
          className="space-y-3"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading notifications"
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-28 w-full" />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications"
          description="You'll see scan alerts, critical finding warnings, and fix PR updates here."
          action={null}
        />
      ) : (
        <div className="space-y-3">
          {notifications.map((notification) => {
            const Icon = CHANNEL_ICONS[notification.channel] ?? Bell
            const badgeVariant = TYPE_COLORS[notification.type] ?? "muted"
            return (
              <Card
                key={notification.id}
                className="hover:shadow-card-hover p-4 transition-shadow duration-(--duration-base) ease-out"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <Icon className="text-muted-foreground h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <h3 className="truncate font-medium">{notification.title}</h3>
                      <Badge variant={badgeVariant}>{notification.type}</Badge>
                      {notification.status === "read" && <Badge variant="muted">read</Badge>}
                    </div>
                    <p className="text-muted-foreground text-sm whitespace-pre-line">
                      {notification.body}
                    </p>
                    <p className="text-muted-foreground mt-2 text-xs">
                      {formatDateTime(notification.createdAt)}
                      {notification.sentAt && <> · Sent {formatDateTime(notification.sentAt)}</>}
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
                `/api/notifications`,
                {
                  workspaceId,
                  cursor,
                },
                { schema: notificationsPaginatedSchema }
              )
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => setNotifications((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
