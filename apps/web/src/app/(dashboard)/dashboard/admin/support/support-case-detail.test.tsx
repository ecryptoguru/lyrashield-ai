import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SupportCaseDetail, type CaseDetail, type CaseReply } from "./support-case-detail"

const caseDetail: CaseDetail = {
  id: "case-1",
  reference: "MYRA-1001",
  status: "OPEN",
  subject: "Cannot finish a scan",
  summary: "The requester sees a blocked scan.",
  accountId: null,
  publicSessionId: "session-1",
  workspaceId: "workspace-1",
  replyEmail: "requester@example.com",
  emailVerifiedAt: "2026-09-15T10:00:00.000Z",
  conversationId: "conversation-1",
  assigneeUserId: null,
  takenOverAt: "2026-09-15T11:00:00.000Z",
  lastUserReplyAt: "2026-09-15T10:30:00.000Z",
  lastOperatorReplyAt: null,
  resolvedAt: null,
  notificationState: "sent",
  handoffSummary: "Myra previously asked for scan details.",
  handoffReviewedAt: null,
  handoffReviewedBy: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T11:00:00.000Z",
}

const replies: CaseReply[] = [
  {
    id: "reply-1",
    caseId: "case-1",
    authorType: "USER",
    authorUserId: null,
    body: "The scan is still blocked.",
    createdAt: "2026-09-15T10:30:00.000Z",
  },
]

const baseProps = {
  selectedId: "case-1",
  detail: { case: caseDetail, replies },
  loading: false,
  error: null,
  busy: null,
  actionError: null,
  replyBody: "Operator reply",
  handoffSummary: "short",
  onReplyBodyChange: () => {},
  onHandoffSummaryChange: () => {},
  onPatch: () => {},
  onSendReply: () => {},
}

describe("SupportCaseDetail", () => {
  it("prompts the operator to select a case", () => {
    const html = renderToStaticMarkup(<SupportCaseDetail {...baseProps} selectedId={null} />)

    expect(html).toContain("Select a case to review it.")
  })

  it("renders loading and error states", () => {
    const loadingHtml = renderToStaticMarkup(<SupportCaseDetail {...baseProps} loading />)
    const errorHtml = renderToStaticMarkup(
      <SupportCaseDetail {...baseProps} detail={null} error="Could not load that case." />
    )

    expect(loadingHtml).toContain("Loading case…")
    expect(errorHtml).toContain("Could not load that case.")
  })

  it("renders a taken-over case with metadata, controls, replies, and reply form", () => {
    const html = renderToStaticMarkup(<SupportCaseDetail {...baseProps} />)

    expect(html).toContain("open")
    expect(html).toContain("Cannot finish a scan")
    expect(html).toContain("Reference")
    expect(html).toContain("MYRA-1001")
    expect(html).toContain("requester@example.com (verified)")
    expect(html).toContain("The requester sees a blocked scan.")
    expect(html).toContain("Myra previously asked for scan details.")
    expect(html).toContain('id="myra-handoff-summary"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Release to Myra<\/button>/)
    expect(html).toContain("Assign to me")
    expect(html).toContain("Resolve")
    expect(html).toContain("Mark pending user")
    expect(html).toContain("The scan is still blocked.")
    expect(html).toContain('id="support-reply"')
    expect(html).toContain("Send reply")
  })

  it("renders Reopen without Resolve for a resolved case", () => {
    const html = renderToStaticMarkup(
      <SupportCaseDetail
        {...baseProps}
        detail={{ case: { ...caseDetail, status: "RESOLVED" }, replies }}
      />
    )

    expect(html).toContain("Reopen")
    expect(html).not.toContain(">Resolve</button>")
  })
})
