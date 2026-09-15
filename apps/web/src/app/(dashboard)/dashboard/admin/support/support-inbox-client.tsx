"use client"

/**
 * Founder support inbox for Myra cases (spec §6).
 *
 * Server routes enforce the boundary: reads need the 12h operator identity
 * window, mutations need the 30-minute TOTP elevation. This client only
 * renders what GET /api/myra/operator/cases returns — it never infers access.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge, Button, Card, Spinner, cn } from "@lyrashield/ui"

type CaseStatus = "NEW" | "OPEN" | "PENDING_USER" | "RESOLVED"

const STATUSES: { value: CaseStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "NEW", label: "New" },
  { value: "OPEN", label: "Open" },
  { value: "PENDING_USER", label: "Pending user" },
  { value: "RESOLVED", label: "Resolved" },
]

interface CaseRow {
  id: string
  reference: string
  status: CaseStatus
  subject: string
  createdAt: string
  updatedAt: string
  assigneeUserId: string | null
  takenOverAt: string | null
  lastUserReplyAt: string | null
  notificationState: string
}

interface CaseReply {
  id: string
  caseId: string
  authorType: "USER" | "OPERATOR" | "MYRA"
  authorUserId: string | null
  body: string
  createdAt: string
}

interface CaseDetail {
  id: string
  reference: string
  status: CaseStatus
  subject: string
  summary: string
  accountId: string | null
  publicSessionId: string | null
  workspaceId: string | null
  replyEmail: string | null
  emailVerifiedAt: string | null
  conversationId: string | null
  assigneeUserId: string | null
  takenOverAt: string | null
  lastUserReplyAt: string | null
  lastOperatorReplyAt: string | null
  resolvedAt: string | null
  notificationState: string
  createdAt: string
  updatedAt: string
}

function statusVariant(status: CaseStatus) {
  switch (status) {
    case "NEW":
      return "info" as const
    case "OPEN":
      return "warning" as const
    case "PENDING_USER":
      return "muted" as const
    case "RESOLVED":
      return "success" as const
  }
}

function authorVariant(author: CaseReply["authorType"]) {
  return author === "OPERATOR" ? ("default" as const) : author === "MYRA" ? ("info" as const) : ("muted" as const)
}

function isUnread(row: CaseRow): boolean {
  if (row.status === "NEW") return true
  if (!row.lastUserReplyAt) return false
  // lastUserReplyAt ≈ updatedAt means the latest activity was a user reply.
  return (
    new Date(row.lastUserReplyAt).getTime() >= new Date(row.updatedAt).getTime() - 60_000
  )
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.valueOf()) ? "—" : d.toLocaleString()
}

async function readError(res: Response): Promise<never> {
  let message = `Request failed (${res.status})`
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) message = body.error.message
    if (res.status === 401 || res.status === 403) {
      message = `${message} — mutations need a fresh two-factor elevation.`
    }
  } catch {
    /* keep the status-line message */
  }
  throw new Error(message)
}

export function SupportInbox() {
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "">("")
  const [rows, setRows] = useState<CaseRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ case: CaseDetail; replies: CaseReply[] } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState("")
  const [announce, setAnnounce] = useState("")

  // setState only inside promise callbacks — an effect may call these, but
  // never synchronously set state (react-hooks/set-state-in-effect).
  const loadList = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams()
      if (statusFilter) params.set("status", statusFilter)
      if (cursor) params.set("cursor", cursor)
      const qs = params.toString()
      return fetch(`/api/myra/operator/cases${qs ? `?${qs}` : ""}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) await readError(res)
          const body = (await res.json()) as {
            data?: CaseRow[] | { cases?: CaseRow[]; nextCursor?: string | null }
          }
          const data = body.data
          const page = Array.isArray(data) ? data : (data?.cases ?? [])
          setNextCursor(Array.isArray(data) ? null : (data?.nextCursor ?? null))
          setRows((prev) => (cursor ? [...prev, ...page] : page))
          setListError(null)
        })
        .catch((e) => {
          setListError(e instanceof Error ? e.message : "Could not load cases.")
          if (!cursor) setRows([])
        })
        .finally(() => {
          setLoadingList(false)
          setLoadingMore(false)
        })
    },
    [statusFilter]
  )

  const loadDetail = useCallback((id: string) => {
    return fetch(`/api/myra/operator/cases/${id}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) await readError(res)
        const body = (await res.json()) as {
          data?: { case: CaseDetail; replies: CaseReply[] }
        }
        setDetail(body.data ?? null)
        setDetailError(null)
      })
      .catch((e) => {
        setDetailError(e instanceof Error ? e.message : "Could not load that case.")
        setDetail(null)
      })
      .finally(() => setLoadingDetail(false))
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  const selectCase = useCallback((id: string | null) => {
    setSelectedId(id)
    setReplyBody("")
    setActionError(null)
    if (id) {
      setLoadingDetail(true)
      setDetail(null)
    } else {
      setLoadingDetail(false)
      setDetail(null)
    }
  }, [])

  const selectStatus = useCallback((status: CaseStatus | "") => {
    setStatusFilter(status)
    setLoadingList(true)
  }, [])

  const patch = useCallback(
    async (action: "takeover" | "release" | "resolve" | "assign", status?: CaseStatus) => {
      if (!selectedId) return
      setBusy(action)
      setActionError(null)
      try {
        const res = await fetch(`/api/myra/operator/cases/${selectedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...(status ? { status } : {}) }),
        })
        if (!res.ok) await readError(res)
        await Promise.all([loadDetail(selectedId), loadList()])
        setAnnounce(
          action === "takeover"
            ? "You are handling this case. Myra is paused on the conversation."
            : action === "release"
              ? "Released — Myra may respond again."
              : `Case marked ${status?.toLowerCase().replace(/_/g, " ") ?? "resolved"}.`
        )
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Could not update that case.")
      } finally {
        setBusy(null)
      }
    },
    [selectedId, loadDetail, loadList]
  )

  const sendReply = useCallback(async () => {
    if (!selectedId || !replyBody.trim()) return
    setBusy("reply")
    setActionError(null)
    try {
      const res = await fetch(`/api/myra/operator/cases/${selectedId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: replyBody.trim() }),
      })
      if (!res.ok) await readError(res)
      setReplyBody("")
      await Promise.all([loadDetail(selectedId), loadList()])
      setAnnounce("Reply sent.")
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not send that reply.")
    } finally {
      setBusy(null)
    }
  }, [selectedId, replyBody, loadDetail, loadList])

  const selected = detail?.case ?? null
  const takenOver = !!selected?.takenOverAt

  const detailMeta = useMemo(() => {
    if (!selected) return []
    const requester = selected.replyEmail
      ? `${selected.replyEmail}${selected.emailVerifiedAt ? " (verified)" : " (unverified)"}`
      : selected.accountId
        ? "Signed-in account"
        : "Anonymous session"
    return [
      ["Reference", selected.reference],
      ["Status", selected.status.toLowerCase().replace(/_/g, " ")],
      ["Requester", requester],
      ["Created", formatTime(selected.createdAt)],
      ["Notify state", selected.notificationState],
      ["Workspace", selected.workspaceId ?? "—"],
      ["Conversation", selected.conversationId ? "linked" : "—"],
      ["Taken over", selected.takenOverAt ? formatTime(selected.takenOverAt) : "—"],
    ] as [string, string][]
  }, [selected])

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      <section aria-label="Case list" className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <button
              key={s.value || "all"}
              type="button"
              onClick={() => selectStatus(s.value)}
              aria-pressed={statusFilter === s.value}
              className={cn(
                "focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none",
                statusFilter === s.value
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {loadingList ? (
          <div className="flex items-center gap-2 p-4">
            <Spinner />
            <span className="text-muted-foreground text-sm">Loading cases…</span>
          </div>
        ) : listError ? (
          <Card className="border-l-2 border-l-amber-500 p-4 text-sm">{listError}</Card>
        ) : rows.length === 0 ? (
          <Card className="text-muted-foreground p-4 text-sm">
            No cases{statusFilter ? ` with status ${statusFilter.toLowerCase().replace(/_/g, " ")}` : ""}.
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => selectCase(row.id)}
                  aria-current={selectedId === row.id || undefined}
                  className={cn(
                    "focus-visible:ring-ring w-full rounded-lg border p-3 text-left focus-visible:ring-2 focus-visible:outline-none",
                    selectedId === row.id ? "border-primary" : "border-border hover:border-primary/60"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(row.status)}>
                      {row.status.toLowerCase().replace(/_/g, " ")}
                    </Badge>
                    {isUnread(row) ? <Badge variant="info">unread</Badge> : null}
                    <span className="text-muted-foreground ml-auto font-mono text-xs">
                      {age(row.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm font-medium">{row.subject}</p>
                  <p className="text-muted-foreground mt-1 font-mono text-xs">
                    {row.reference}
                    {row.takenOverAt ? " · handled" : ""}
                    {row.notificationState === "failed" ? " · notify failed" : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}

        {nextCursor ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true)
              void loadList(nextCursor)
            }}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </section>

      <section aria-label="Case detail" aria-live="off">
        {!selectedId ? (
          <Card className="text-muted-foreground p-6 text-sm">Select a case to review it.</Card>
        ) : loadingDetail ? (
          <div className="flex items-center gap-2 p-4">
            <Spinner />
            <span className="text-muted-foreground text-sm">Loading case…</span>
          </div>
        ) : detailError ? (
          <Card className="border-l-2 border-l-amber-500 p-4 text-sm">{detailError}</Card>
        ) : selected ? (
          <div className="flex flex-col gap-4">
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(selected.status)}>
                  {selected.status.toLowerCase().replace(/_/g, " ")}
                </Badge>
                <h2 className="text-base font-semibold">{selected.subject}</h2>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                {detailMeta.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground font-mono uppercase">{k}</dt>
                    <dd className="mt-0.5 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 border-t pt-3">
                <h3 className="text-muted-foreground font-mono text-xs uppercase">Summary</h3>
                <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{selected.summary}</p>
              </div>

              <div className="mt-4 flex flex-wrap gap-2 border-t pt-3" aria-label="Case controls">
                {!takenOver ? (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void patch("takeover")}
                    title="Assigns you and pauses Myra on the linked conversation"
                  >
                    Take over
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void patch("release")}
                  >
                    Release to Myra
                  </Button>
                )}
                {selected.status !== "RESOLVED" ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void patch("resolve", "RESOLVED")}
                    >
                      Resolve
                    </Button>
                    {selected.status !== "PENDING_USER" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void patch("resolve", "PENDING_USER")}
                      >
                        Mark pending user
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void patch("resolve", "OPEN")}
                  >
                    Reopen
                  </Button>
                )}
              </div>
              {actionError ? (
                <p className="text-destructive mt-2 text-sm" role="alert">
                  {actionError}
                </p>
              ) : null}
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold">Replies</h3>
              {detail && detail.replies.length === 0 ? (
                <p className="text-muted-foreground mt-2 text-sm">No replies yet.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {detail?.replies.map((reply) => (
                    <li key={reply.id} className="rounded-lg border p-3">
                      <div className="flex items-center gap-2">
                        <Badge variant={authorVariant(reply.authorType)}>
                          {reply.authorType === "MYRA"
                            ? "Myra"
                            : reply.authorType === "OPERATOR"
                              ? "Operator"
                              : "User"}
                        </Badge>
                        <span className="text-muted-foreground font-mono text-xs">
                          {formatTime(reply.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">
                        {reply.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 border-t pt-3">
                <label htmlFor="support-reply" className="text-sm font-medium">
                  Reply to requester
                </label>
                <textarea
                  id="support-reply"
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  className="border-input bg-background focus-visible:ring-ring mt-2 w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                  placeholder="Reply as the operator. The requester sees this verbatim."
                />
                <div className="mt-2">
                  <Button
                    size="sm"
                    disabled={busy !== null || !replyBody.trim()}
                    onClick={() => void sendReply()}
                  >
                    {busy === "reply" ? "Sending…" : "Send reply"}
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        ) : null}
      </section>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  )
}
