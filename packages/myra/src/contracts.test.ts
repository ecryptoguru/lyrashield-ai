/**
 * Unit tests for the Myra contract schemas (spec §3, §5, §13.6). These pin
 * the allowlist of renderable components, the stream-event protocol, the
 * TaskRecord shape and strict request-payload validation.
 */
import { describe, expect, it } from "vitest"
import {
  MYRA_COPY,
  MYRA_ERROR_CODES,
  MYRA_LIMITS,
  MYRA_TOOL_NAMES,
  answerComponent,
  bookDemoPayloadSchema,
  caseReplyRequestSchema,
  confirmProposalRequestSchema,
  demoSlotsRequestSchema,
  identityConfirmSchema,
  identityRequestSchema,
  manageDemoRequestSchema,
  myraComponentSchema,
  myraErrorSchema,
  myraStreamEventSchema,
  postMessageRequestSchema,
  submitCasePayloadSchema,
  suggestRequestSchema,
  taskRecordSchema,
} from "./contracts"

// ─── Component schemas ─────────────────────────────────────────────────────

const validComponents: Record<string, unknown> = {
  answer: { type: "answer", markdown: "Here is **how**." },
  source_link: { type: "source_link", label: "Pricing", url: "https://lyrashieldai.com/pricing" },
  plan_comparison: {
    type: "plan_comparison",
    checkedAt: "2026-09-15T00:00:00Z",
    plans: [
      {
        id: "PRO",
        name: "Pro",
        monthlyUsd: 99,
        monthlyInr: 9900,
        agentMinutes: 850,
        targetCaps: 15,
        memberSeats: 1,
        deepAllowed: true,
        selfServe: true,
        availability: "available",
        ctaRoute: "/pricing",
      },
    ],
  },
  diagnostic_status: {
    type: "diagnostic_status",
    title: "Scan setup",
    checkedAt: "2026-09-15T00:00:00Z",
    checks: [
      { id: "target", label: "Target exists", status: "pass", ctaRoute: "/dashboard/targets" },
    ],
  },
  task_steps: {
    type: "task_steps",
    steps: [{ id: "s1", title: "Add a target", status: "active", ctaRoute: "/dashboard/targets" }],
  },
  support_case_preview: {
    type: "support_case_preview",
    proposalId: "prop_1",
    subject: "Cannot start a scan",
    summary: "The scan button does nothing.",
    replyDestination: "user@example.com",
    includeDiagnostics: true,
    includeTranscriptExcerpt: false,
    expiresAt: "2026-09-15T00:15:00Z",
  },
  slot_picker: {
    type: "slot_picker",
    displayTimezone: "Asia/Kolkata",
    slots: [
      { id: "slot_1", startsAt: "2026-09-16T15:00:00+05:30", endsAt: "2026-09-16T15:30:00+05:30" },
    ],
  },
  action_confirmation: {
    type: "action_confirmation",
    proposalId: "prop_1",
    title: "Submit support case?",
    description: "Sends the summary to support.",
    confirmLabel: "Submit",
    expiresAt: "2026-09-15T00:15:00Z",
  },
  action_result: {
    type: "action_result",
    proposalId: "prop_1",
    status: "COMPLETED",
    title: "Case submitted",
    detail: "Your request is saved as CS-1.",
    reference: "CS-1",
  },
  guided_flow: {
    type: "guided_flow",
    flowId: "scan_wont_start",
    flowTitle: "Get your scan running",
    stepIndex: 1,
    status: "ACTIVE",
    steps: [
      { id: "target_exists", title: "A target exists", status: "done" },
      { id: "entitlement_ok", title: "Your plan can run the scan", status: "active" },
    ],
  },
  instant_suggestions: {
    type: "instant_suggestions",
    suggestions: [
      {
        entryId: "kb_install_cli",
        title: "Install the CLI",
        snippet: "npm i -g lyrashield",
        sourceUrl: "https://lyrashieldai.com/docs/integrations",
      },
    ],
  },
  memory_card: {
    type: "memory_card",
    entries: [{ key: "preferred_timezone", label: "Timezone: Asia/Kolkata" }],
  },
  capability_line: {
    type: "capability_line",
    canSee: ["your plan minutes"],
    cannotSee: ["page fields", "clipboard"],
  },
  trace_ref: { type: "trace_ref", traceId: "tr_123" },
}

describe("component schemas", () => {
  it("accepts a valid payload for every component type", () => {
    for (const [type, fixture] of Object.entries(validComponents)) {
      const parsed = myraComponentSchema.safeParse(fixture)
      expect(parsed.success, `valid ${type} must parse`).toBe(true)
    }
  })

  it("rejects wrong-typed required fields", () => {
    const bad: [string, unknown][] = [
      ["answer", { type: "answer", markdown: 42 }],
      ["source_link", { type: "source_link", label: "x", url: 7 }],
      ["plan_comparison", { type: "plan_comparison", checkedAt: "t", plans: "none" }],
      ["diagnostic_status", { type: "diagnostic_status", title: 1, checkedAt: "t", checks: [] }],
      ["task_steps", { type: "task_steps", steps: [{ id: "s", title: "t", status: "maybe" }] }],
      [
        "action_confirmation",
        {
          type: "action_confirmation",
          proposalId: 1,
          title: "t",
          description: "d",
          confirmLabel: "c",
          expiresAt: "e",
        },
      ],
      [
        "guided_flow",
        {
          type: "guided_flow",
          flowId: "f",
          flowTitle: "t",
          stepIndex: -1,
          status: "ACTIVE",
          steps: [],
        },
      ],
      [
        "instant_suggestions",
        {
          type: "instant_suggestions",
          suggestions: [{ entryId: "e", title: "t", snippet: "s", sourceUrl: 9 }],
        },
      ],
      ["memory_card", { type: "memory_card", entries: [{ key: "k" }] }],
      ["capability_line", { type: "capability_line", canSee: "all", cannotSee: [] }],
    ]
    for (const [name, fixture] of bad) {
      expect(myraComponentSchema.safeParse(fixture).success, `${name} must reject`).toBe(false)
    }
  })

  it("strips unknown keys rather than passing them through", () => {
    // Component objects are intentionally not .strict() — the renderer owns
    // the allowlist, but extra keys must not survive parsing either.
    const parsed = answerComponent.safeParse({
      type: "answer",
      markdown: "hi",
      onload: "alert(1)",
      href: "javascript:x",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ type: "answer", markdown: "hi" })
    expect("onload" in parsed.data!).toBe(false)
  })

  it("rejects bad enum values inside nested objects", () => {
    const badAvailability = myraComponentSchema.safeParse({
      ...(validComponents.plan_comparison as object),
      plans: [
        {
          id: "X",
          name: "X",
          monthlyUsd: 1,
          monthlyInr: 1,
          agentMinutes: 1,
          targetCaps: 1,
          memberSeats: 1,
          deepAllowed: false,
          selfServe: false,
          availability: "free", // not an allowed availability state
        },
      ],
    })
    expect(badAvailability.success).toBe(false)

    const badStatus = myraComponentSchema.safeParse({
      type: "diagnostic_status",
      title: "t",
      checkedAt: "t",
      checks: [{ id: "c", label: "l", status: "green" }],
    })
    expect(badStatus.success).toBe(false)
  })

  it("rejects unknown component types", () => {
    for (const fixture of [
      { type: "iframe", html: "<script>" },
      { type: "raw_html", html: "<b>" },
      { type: "form", fields: [] },
      { type: "ANSWER", markdown: "x" },
    ]) {
      expect(myraComponentSchema.safeParse(fixture).success).toBe(false)
    }
  })

  it("enforces collection caps", () => {
    expect(
      myraComponentSchema.safeParse({
        type: "instant_suggestions",
        suggestions: Array.from({ length: 6 }, (_, i) => ({
          entryId: `e${i}`,
          title: "t",
          snippet: "s",
        })),
      }).success
    ).toBe(false)
    expect(
      myraComponentSchema.safeParse({
        type: "plan_comparison",
        checkedAt: "t",
        plans: Array.from({ length: 9 }, (_, i) => ({
          id: `p${i}`,
          name: "n",
          monthlyUsd: 1,
          monthlyInr: 1,
          agentMinutes: 1,
          targetCaps: 1,
          memberSeats: 1,
          deepAllowed: false,
          selfServe: true,
          availability: "available",
        })),
      }).success
    ).toBe(false)
  })
})

// ─── Stream events ─────────────────────────────────────────────────────────

describe("stream event schemas", () => {
  const events: unknown[] = [
    { type: "ready", conversationId: "conv_1", traceId: "tr_1" },
    { type: "activity", label: "Checking your plan minutes" },
    { type: "token", text: "Hello" },
    { type: "component", component: validComponents.answer },
    {
      type: "proposal",
      proposal: {
        id: "prop_1",
        operationName: "submit_support_case",
        title: "Submit case",
        description: "Sends your summary",
        payloadPreview: { subject: "help" },
        expiresAt: "2026-09-15T00:15:00Z",
      },
    },
    { type: "operation", operationId: "op_1", status: "EXECUTING" },
    {
      type: "done",
      messageId: "msg_1",
      taskRecord: {
        intent: "pricing_question",
        toolsUsed: ["read_product_catalog"],
        outcome: "answered",
        unresolved: false,
      },
    },
    { type: "error", error: { code: "FORBIDDEN", message: "denied" } },
  ]

  it("round-trips every stream event through JSON", () => {
    for (const event of events) {
      const wire = JSON.parse(JSON.stringify(event))
      const parsed = myraStreamEventSchema.safeParse(wire)
      expect(parsed.success, JSON.stringify(event)).toBe(true)
      expect(parsed.data).toEqual(event)
    }
  })

  it("rejects unknown event types and malformed payloads", () => {
    for (const bad of [
      { type: "reasoning", text: "hidden chain of thought" }, // hidden reasoning must never stream
      { type: "token", text: 1 },
      { type: "operation", operationId: "o", status: "half_done" },
      { type: "done", messageId: "m" }, // taskRecord required
      { type: "error", error: { code: "NOT_A_CODE", message: "x" } },
    ]) {
      expect(myraStreamEventSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("taskRecordSchema", () => {
  it("accepts valid records and all outcome codes", () => {
    for (const outcome of [
      "answered",
      "abstained",
      "escalated",
      "action_proposed",
      "action_done",
      "error",
    ]) {
      expect(
        taskRecordSchema.safeParse({ intent: "x", toolsUsed: [], outcome, unresolved: false })
          .success,
        outcome
      ).toBe(true)
    }
  })

  it("rejects tools outside the registry and bad outcomes", () => {
    expect(
      taskRecordSchema.safeParse({
        intent: "x",
        toolsUsed: ["delete_everything"],
        outcome: "answered",
        unresolved: false,
      }).success
    ).toBe(false)
    expect(
      taskRecordSchema.safeParse({
        intent: "x",
        toolsUsed: [],
        outcome: "resolved",
        unresolved: false,
      }).success
    ).toBe(false)
  })
})

describe("myraErrorSchema", () => {
  it("covers the codes the confirmation/authorization flow relies on", () => {
    for (const code of [
      "FORBIDDEN",
      "PROPOSAL_PAYLOAD_CHANGED",
      "PROPOSAL_EXPIRED",
      "PROPOSAL_STATE_INVALID",
      "OWNERSHIP_MISMATCH",
      "TAKEOVER_ACTIVE",
      "SLOT_UNAVAILABLE",
      "BUDGET_EXHAUSTED",
    ]) {
      expect(MYRA_ERROR_CODES).toContain(code)
      expect(myraErrorSchema.safeParse({ code, message: "m" }).success).toBe(true)
    }
  })
})

// ─── Request payload strictness ────────────────────────────────────────────

describe("request schemas", () => {
  it("postMessageRequestSchema accepts valid input and rejects extras", () => {
    expect(postMessageRequestSchema.safeParse({ text: "hi", surface: "MARKETING" }).success).toBe(
      true
    )
    expect(
      postMessageRequestSchema.safeParse({
        text: "hi",
        surface: "DASHBOARD",
        conversationId: "c",
        routeContext: "/dashboard",
      }).success
    ).toBe(true)
    // Strict: client-asserted authority fields must be rejected, never trusted.
    for (const bad of [
      { text: "hi", surface: "DASHBOARD", workspaceId: "ws_other" },
      { text: "hi", surface: "DASHBOARD", role: "OWNER" },
      { text: "hi", surface: "DASHBOARD", accountId: "acct_x" },
      { text: "hi", surface: "DASHBOARD", isAdmin: true },
      { surface: "DASHBOARD" }, // text required
      { text: "", surface: "DASHBOARD" },
      { text: "x".repeat(4001), surface: "DASHBOARD" },
      { text: "hi", surface: "NEWSITE" },
    ]) {
      expect(postMessageRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it("suggestRequestSchema is strict and bounds text", () => {
    expect(suggestRequestSchema.safeParse({ text: "how", surface: "MARKETING" }).success).toBe(true)
    expect(suggestRequestSchema.safeParse({ text: "x", surface: "MARKETING" }).success).toBe(false)
    expect(
      suggestRequestSchema.safeParse({ text: "how", surface: "MARKETING", admin: true }).success
    ).toBe(false)
  })

  it("confirmProposalRequestSchema takes only a proposalId", () => {
    expect(confirmProposalRequestSchema.safeParse({ proposalId: "p1" }).success).toBe(true)
    expect(confirmProposalRequestSchema.safeParse({ proposalId: "p1", payload: {} }).success).toBe(
      false
    )
    expect(confirmProposalRequestSchema.safeParse({}).success).toBe(false)
  })

  it("submitCasePayloadSchema validates the exact confirmed payload", () => {
    const ok = submitCasePayloadSchema.safeParse({
      subject: "Cannot start scan",
      summary: "The button does nothing when clicked.",
      replyEmail: "user@example.com",
    })
    expect(ok.success).toBe(true)
    expect(ok.data).toMatchObject({ includeDiagnostics: false, includeTranscriptExcerpt: false })
    for (const bad of [
      { subject: "abc", summary: "short summary" }, // subject min 4
      { subject: "valid subject", summary: "short" }, // summary min 10
      { subject: "valid subject", summary: "a long enough summary", replyEmail: "not-an-email" },
      { subject: "valid subject", summary: "a long enough summary", sendTo: "evil@x.com" },
    ]) {
      expect(submitCasePayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it("bookDemoPayloadSchema enforces datetime + email + strict keys", () => {
    expect(
      bookDemoPayloadSchema.safeParse({
        slotStart: "2026-09-20T15:00:00+05:30",
        timezone: "America/New_York",
        name: "Dev",
        email: "dev@example.com",
      }).success
    ).toBe(true)
    for (const bad of [
      { slotStart: "tomorrow at 3", timezone: "x", name: "n", email: "a@b.com" },
      { slotStart: "2026-09-20T15:00:00+05:30", timezone: "x", name: "n", email: "bad" },
      {
        slotStart: "2026-09-20T15:00:00+05:30",
        timezone: "x",
        name: "n",
        email: "a@b.com",
        force: true,
      },
    ]) {
      expect(bookDemoPayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it("identity schemas bound purpose and code format", () => {
    expect(
      identityRequestSchema.safeParse({ email: "a@b.com", purpose: "support_case" }).success
    ).toBe(true)
    expect(
      identityRequestSchema.safeParse({ email: "a@b.com", purpose: "marketing" }).success
    ).toBe(false)
    expect(
      identityConfirmSchema.safeParse({ email: "a@b.com", purpose: "demo_booking", code: "123456" })
        .success
    ).toBe(true)
    expect(
      identityConfirmSchema.safeParse({ email: "a@b.com", purpose: "demo_booking", code: "12" })
        .success
    ).toBe(false)
    expect(
      identityConfirmSchema.safeParse({
        email: "a@b.com",
        purpose: "demo_booking",
        code: "123456",
        skip: true,
      }).success
    ).toBe(false)
  })

  it("demoSlotsRequestSchema requires YYYY-MM-DD window start", () => {
    expect(demoSlotsRequestSchema.safeParse({ timezone: "UTC", from: "2026-09-20" }).success).toBe(
      true
    )
    for (const from of ["09/20/2026", "2026-9-2", "next week", "2026-09-20T00:00:00Z"]) {
      expect(demoSlotsRequestSchema.safeParse({ timezone: "UTC", from }).success, from).toBe(false)
    }
  })

  it("manageDemoRequestSchema and caseReplyRequestSchema stay strict", () => {
    expect(manageDemoRequestSchema.safeParse({ action: "cancel" }).success).toBe(true)
    expect(
      manageDemoRequestSchema.safeParse({
        action: "reschedule",
        newSlotStart: "2026-09-21T15:00:00+05:30",
      }).success
    ).toBe(true)
    expect(manageDemoRequestSchema.safeParse({ action: "refund" }).success).toBe(false)
    expect(
      manageDemoRequestSchema.safeParse({ action: "cancel", bookingId: "other" }).success
    ).toBe(false)
    expect(caseReplyRequestSchema.safeParse({ body: "more info" }).success).toBe(true)
    expect(caseReplyRequestSchema.safeParse({ body: "" }).success).toBe(false)
    expect(caseReplyRequestSchema.safeParse({ body: "x", asOperator: true }).success).toBe(false)
  })
})

// ─── Registry + limits + copy ──────────────────────────────────────────────

describe("tool registry contract", () => {
  it("contains exactly the spec'd tools with unique names", () => {
    expect(MYRA_TOOL_NAMES.length).toBe(21)
    expect(new Set(MYRA_TOOL_NAMES).size).toBe(21)
    for (const v11 of [
      "instant_suggest",
      "start_guided_flow",
      "advance_guided_flow",
      "verify_resolution",
      "read_memory",
      "write_memory",
      "clear_memory",
      "attach_trace",
    ]) {
      expect(MYRA_TOOL_NAMES).toContain(v11)
    }
    // Generic escape hatches must stay absent (spec §5).
    for (const forbidden of ["http_request", "run_sql", "shell", "browser", "mutate_scan"]) {
      expect(MYRA_TOOL_NAMES).not.toContain(forbidden)
    }
  })
})

describe("MYRA_LIMITS pin the founder-resolved values", () => {
  it("matches spec §11 resolved decisions", () => {
    expect(MYRA_LIMITS.maxToolStepsPerTurn).toBe(6)
    expect(MYRA_LIMITS.maxOutputTokensPerTurn).toBe(4000)
    expect(MYRA_LIMITS.monthlyBudgetUsd).toBe(50)
    expect(MYRA_LIMITS.proposalTtlMinutes).toBe(15)
    expect(MYRA_LIMITS.demo.durationMinutes).toBe(30)
    expect(MYRA_LIMITS.demo.bufferMinutes).toBe(15)
    expect(MYRA_LIMITS.demo.minNoticeHours).toBe(24)
    expect(MYRA_LIMITS.demo.horizonDays).toBe(14)
    expect(MYRA_LIMITS.demo.hostTimezone).toBe("Asia/Kolkata")
    expect(MYRA_LIMITS.demo.organizerEmail).toBe("ankit@lyrashieldai.com")
  })
})

describe("MYRA_COPY pins the spec'd exact strings", () => {
  it("matches spec §6/§7 copy", () => {
    expect(MYRA_COPY.header).toBe("Myra · AI support")
    expect(MYRA_COPY.caseDraft).toBe("Review what we'll send to support.")
    expect(MYRA_COPY.caseSaved("CS-42")).toBe("Your request is saved as CS-42.")
    expect(MYRA_COPY.caseOffline).toBe(
      "No one is available for live chat right now. Your request is in the support queue."
    )
    expect(MYRA_COPY.caseDeliveryProblem).toBe(
      "Your request is saved, but the notification has not been delivered yet."
    )
    expect(MYRA_COPY.contactFallback).toBe("You can also contact support through our support page.")
    expect(MYRA_COPY.demoConfirmed("Mon 3pm")).toBe("Your demo is booked for Mon 3pm.")
    expect(MYRA_COPY.demoMeetPending).toBe(
      "Your booking is confirmed. We are still preparing the Meet link."
    )
    expect(MYRA_COPY.demoUnknown).toBe(
      "We are checking whether your booking went through. You do not need to submit it again."
    )
    expect(MYRA_COPY.demoConflict).toBe("That time is no longer available. Choose another slot.")
    expect(MYRA_COPY.demoNoSlots).toBe(
      "There are no open slots in this window. Request a time instead."
    )
    expect(MYRA_COPY.demoFailure).toBe(
      "We could not complete the booking. Your details are still in the form."
    )
    expect(MYRA_COPY.toolPageDisclosure).toBe(
      "Messages sent to Myra are processed by our support service. Your tool inputs stay in your browser unless you choose to share them."
    )
  })
})
