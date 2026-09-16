"use client"

/**
 * Founder support inbox for Myra cases (spec §6).
 *
 * Server routes enforce the boundary: reads need the 12h operator identity
 * window, mutations need the 30-minute TOTP elevation. This client only
 * renders what GET /api/myra/operator/cases returns — it never infers access.
 */
import { useCallback, useEffect, useState } from "react"
import { Badge, Button, Card, Spinner, cn } from "@lyrashield/ui"
import {
  SupportCaseDetail,
  supportCaseStatusVariant,
  type CaseDetail,
  type CaseReply,
  type CaseStatus,
} from "./support-case-detail"

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

function isUnread(row: CaseRow): boolean {
  if (row.status === "NEW") return true
  if (!row.lastUserReplyAt) return false
  // lastUserReplyAt ≈ updatedAt means the latest activity was a user reply.
  return new Date(row.lastUserReplyAt).getTime() >= new Date(row.updatedAt).getTime() - 60_000
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
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
  const [handoffSummary, setHandoffSummary] = useState("")
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
    setHandoffSummary("")
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
          body: JSON.stringify({
            action,
            ...(status ? { status } : {}),
            ...(action === "release" ? { handoffSummary } : {}),
          }),
        })
        if (!res.ok) await readError(res)
        await Promise.all([loadDetail(selectedId), loadList()])
        setAnnounce(
          action === "takeover"
            ? "You are handling this case. Myra is paused on the conversation."
            : action === "release"
              ? "Released — Myra may respond again."
              : action === "assign"
                ? "Case assigned to you."
                : `Case marked ${status?.toLowerCase().replace(/_/g, " ") ?? "resolved"}.`
        )
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Could not update that case.")
      } finally {
        setBusy(null)
      }
    },
    [selectedId, loadDetail, loadList, handoffSummary]
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
            No cases
            {statusFilter ? ` with status ${statusFilter.toLowerCase().replace(/_/g, " ")}` : ""}.
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
                    selectedId === row.id
                      ? "border-primary"
                      : "border-border hover:border-primary/60"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={supportCaseStatusVariant(row.status)}>
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

      <SupportCaseDetail
        selectedId={selectedId}
        detail={detail}
        loading={loadingDetail}
        error={detailError}
        busy={busy}
        actionError={actionError}
        replyBody={replyBody}
        handoffSummary={handoffSummary}
        onReplyBodyChange={setReplyBody}
        onHandoffSummaryChange={setHandoffSummary}
        onPatch={(action, status) => void patch(action, status)}
        onSendReply={() => void sendReply()}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  )
}
