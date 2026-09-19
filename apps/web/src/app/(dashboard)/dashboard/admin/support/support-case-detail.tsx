import type React from "react"
import { Badge, Button, Card, Input, Spinner } from "@lyrashield/ui"
import { formatDateTime } from "@/lib/date-format"

export type CaseStatus = "NEW" | "OPEN" | "PENDING_USER" | "RESOLVED"

export interface CaseReply {
  id: string
  caseId: string
  authorType: "USER" | "OPERATOR" | "MYRA"
  authorUserId: string | null
  body: string
  createdAt: string
}

export interface CaseDetail {
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
  handoffSummary: string | null
  handoffReviewedAt: string | null
  handoffReviewedBy: string | null
  createdAt: string
  updatedAt: string
}

export function supportCaseStatusVariant(status: CaseStatus) {
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
  return author === "OPERATOR"
    ? ("default" as const)
    : author === "MYRA"
      ? ("info" as const)
      : ("muted" as const)
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.valueOf()) ? "—" : formatDateTime(d)
}

export function SupportCaseDetail(props: {
  selectedId: string | null
  detail: { case: CaseDetail; replies: CaseReply[] } | null
  loading: boolean
  error: string | null
  busy: string | null
  actionError: string | null
  replyBody: string
  handoffSummary: string
  elevationCode: string
  onReplyBodyChange: (value: string) => void
  onHandoffSummaryChange: (value: string) => void
  onElevationCodeChange: (value: string) => void
  onPatch: (action: "takeover" | "release" | "resolve" | "assign", status?: CaseStatus) => void
  onSendReply: () => void
}): React.ReactNode {
  const {
    selectedId,
    detail,
    loading,
    error,
    busy,
    actionError,
    replyBody,
    handoffSummary,
    elevationCode,
    onReplyBodyChange,
    onHandoffSummaryChange,
    onElevationCodeChange,
    onPatch,
    onSendReply,
  } = props
  const selected = detail?.case ?? null
  const takenOver = !!selected?.takenOverAt

  const detailMeta = selected
    ? ([
        ["Reference", selected.reference],
        ["Status", selected.status.toLowerCase().replace(/_/g, " ")],
        [
          "Requester",
          selected.replyEmail
            ? `${selected.replyEmail}${selected.emailVerifiedAt ? " (verified)" : " (unverified)"}`
            : selected.accountId
              ? "Signed-in account"
              : "Anonymous session",
        ],
        ["Created", formatTime(selected.createdAt)],
        ["Notify state", selected.notificationState],
        ["Workspace", selected.workspaceId ?? "—"],
        ["Conversation", selected.conversationId ? "linked" : "—"],
        ["Taken over", selected.takenOverAt ? formatTime(selected.takenOverAt) : "—"],
      ] as [string, string][])
    : []

  return (
    <section aria-label="Case detail" aria-live="off">
      {!selectedId ? (
        <Card className="text-muted-foreground p-6 text-sm">Select a case to review it.</Card>
      ) : loading ? (
        <div className="flex items-center gap-2 p-4">
          <Spinner />
          <span className="text-muted-foreground text-sm">Loading case…</span>
        </div>
      ) : error ? (
        <Card className="border-l-2 border-l-amber-500 p-4 text-sm">{error}</Card>
      ) : selected ? (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={supportCaseStatusVariant(selected.status)}>
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

            {selected.handoffSummary ? (
              <div className="mt-4 border-t pt-3">
                <h3 className="text-muted-foreground font-mono text-xs uppercase">
                  Last handoff to Myra
                </h3>
                <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">
                  {selected.handoffSummary}
                </p>
              </div>
            ) : null}

            {takenOver ? (
              <div className="mt-4 border-t pt-3">
                <label htmlFor="myra-handoff-summary" className="text-sm font-medium">
                  Reviewed handoff summary
                </label>
                <p className="text-muted-foreground mt-1 text-xs">
                  Tell Myra what was resolved and what the requester should do next.
                </p>
                <textarea
                  id="myra-handoff-summary"
                  value={handoffSummary}
                  maxLength={4000}
                  rows={4}
                  onChange={(event) => onHandoffSummaryChange(event.target.value)}
                  className="border-input bg-background focus-visible:ring-ring mt-2 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                />
              </div>
            ) : null}

            <div className="mt-4 border-t pt-3">
              <label htmlFor="operator-elevation-code" className="text-sm font-medium">
                Authenticator code
              </label>
              <p className="text-muted-foreground mt-1 text-xs">
                Every case action consumes a fresh one-time elevation — enter the current 6-digit
                code from your authenticator app before clicking an action or sending a reply.
              </p>
              <Input
                id="operator-elevation-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                value={elevationCode}
                onChange={(event) =>
                  onElevationCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                className="mt-2 max-w-40 text-center font-mono tracking-[0.3em]"
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3" aria-label="Case controls">
              {!takenOver ? (
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => onPatch("takeover")}
                  title="Assigns you and pauses Myra on the linked conversation"
                >
                  Take over
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null || handoffSummary.trim().length < 10}
                  onClick={() => onPatch("release")}
                >
                  Release to Myra
                </Button>
              )}
              {!selected.assigneeUserId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => onPatch("assign")}
                >
                  Assign to me
                </Button>
              ) : null}
              {selected.status !== "RESOLVED" ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => onPatch("resolve", "RESOLVED")}
                  >
                    Resolve
                  </Button>
                  {selected.status !== "PENDING_USER" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => onPatch("resolve", "PENDING_USER")}
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
                  onClick={() => onPatch("resolve", "OPEN")}
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
                    <p className="mt-1.5 text-sm break-words whitespace-pre-wrap">{reply.body}</p>
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
                onChange={(e) => onReplyBodyChange(e.target.value)}
                rows={4}
                maxLength={4000}
                className="border-input bg-background focus-visible:ring-ring mt-2 w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                placeholder="Reply as the operator. The requester sees this verbatim."
              />
              <div className="mt-2">
                <Button
                  size="sm"
                  disabled={busy !== null || !replyBody.trim()}
                  onClick={onSendReply}
                >
                  {busy === "reply" ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </section>
  )
}
