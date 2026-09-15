/**
 * Myra shared contracts — the single source of truth for the support agent's
 * tool registry, renderable components, stream protocol and API payloads.
 *
 * This module is dependency-light on purpose: it is imported by BOTH the
 * Next.js app (apps/web) and the Astro/Cloudflare marketing app. It must not
 * import Node-only modules, Prisma, or auth — those live under `./server`.
 * Everything the model can emit and every client/server payload is validated
 * here.
 */
import { z } from "zod"

// ─── Enumerations (mirrors Prisma enums; keep in sync) ─────────────────────

export const MYRA_SURFACES = ["MARKETING", "DASHBOARD"] as const
export const myraSurfaceSchema = z.enum(MYRA_SURFACES)
export type MyraSurface = z.infer<typeof myraSurfaceSchema>

export const MYRA_MESSAGE_ROLES = ["USER", "ASSISTANT", "TOOL_EVENT"] as const
export type MyraMessageRole = (typeof MYRA_MESSAGE_ROLES)[number]

export const MYRA_OPERATION_STATUSES = [
  "DRAFT",
  "AWAITING_CONFIRMATION",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "OUTCOME_UNKNOWN",
  "EXPIRED",
  "CANCELED",
] as const
export const myraOperationStatusSchema = z.enum(MYRA_OPERATION_STATUSES)
export type MyraOperationStatus = z.infer<typeof myraOperationStatusSchema>

export const MYRA_FLOW_STATUSES = ["ACTIVE", "COMPLETED", "ESCALATED", "ABANDONED"] as const
export type MyraFlowStatus = (typeof MYRA_FLOW_STATUSES)[number]

export const SUPPORT_CASE_STATUSES = ["NEW", "OPEN", "PENDING_USER", "RESOLVED"] as const
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number]

export const DEMO_BOOKING_STATUSES = [
  "HELD",
  "CONFIRMED",
  "CANCELED",
  "OUTCOME_UNKNOWN",
] as const
export type DemoBookingStatus = (typeof DEMO_BOOKING_STATUSES)[number]

// ─── Error codes ───────────────────────────────────────────────────────────

export const MYRA_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "MYRA_DISABLED",
  "GENERATION_DISABLED",
  "WRITES_DISABLED",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_PAYLOAD_CHANGED",
  "PROPOSAL_STATE_INVALID",
  "OWNERSHIP_MISMATCH",
  "TAKEOVER_ACTIVE",
  "SLOT_UNAVAILABLE",
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "CALENDAR_NOT_CONFIGURED",
  "INTERNAL_ERROR",
] as const
export type MyraErrorCode = (typeof MYRA_ERROR_CODES)[number]

export const myraErrorSchema = z.object({
  code: z.enum(MYRA_ERROR_CODES),
  message: z.string().max(500),
})
export type MyraError = z.infer<typeof myraErrorSchema>

// ─── Tool registry contract ────────────────────────────────────────────────

export const MYRA_TOOL_NAMES = [
  "search_public_help",
  "read_product_catalog",
  "instant_suggest",
  "get_my_context",
  "get_scan_status",
  "get_connection_health",
  "guide_workflow",
  "propose_support_case",
  "submit_support_case",
  "read_own_case",
  "send_case_reply",
  "get_demo_slots",
  "book_demo",
  "manage_own_demo",
  "start_guided_flow",
  "advance_guided_flow",
  "verify_resolution",
  "read_memory",
  "write_memory",
  "attach_trace",
] as const
export const myraToolNameSchema = z.enum(MYRA_TOOL_NAMES)
export type MyraToolName = z.infer<typeof myraToolNameSchema>

/**
 * Who may invoke a tool.
 *  - public: anonymous public session AND authenticated users
 *  - authenticated: browser-session users only (never anonymous, never API keys)
 *  - operator: platform operators only (support inbox)
 */
export type MyraToolAudience = "public" | "authenticated" | "operator"

/**
 * Side-effect class. `confirmed-write` tools never execute inline — they only
 * produce an operation proposal; execution happens through the confirmation
 * engine after an authenticated user gesture binds the exact payload.
 */
export type MyraToolEffect = "read" | "draft" | "confirmed-write"

export interface MyraToolDefinition {
  name: MyraToolName
  audience: MyraToolAudience
  effect: MyraToolEffect
  /** One-line description for prompts and the dev trace inspector. */
  description: string
  /** Hard ceiling for output size; the service truncates beyond this. */
  maxOutputBytes: number
}

// ─── Principal (resolved outside the model — never client-asserted) ────────

export interface MyraPrincipalAnonymous {
  kind: "anonymous"
  publicSessionId: string
}
export interface MyraPrincipalUser {
  kind: "user"
  accountId: string
  sessionId: string
  workspaceId: string | null
  role: string | null
}
export interface MyraPrincipalOperator {
  kind: "operator"
  accountId: string
  sessionId: string
}
export type MyraPrincipal =
  | MyraPrincipalAnonymous
  | MyraPrincipalUser
  | MyraPrincipalOperator

// ─── Renderable components (allowlist — deterministic rendering only) ──────

const urlSchema = z.string().max(2048)

export const answerComponent = z.object({
  type: z.literal("answer"),
  markdown: z.string().max(8000),
})

export const sourceLinkComponent = z.object({
  type: z.literal("source_link"),
  label: z.string().max(120),
  url: urlSchema,
})

export const planComparisonComponent = z.object({
  type: z.literal("plan_comparison"),
  checkedAt: z.string().max(40),
  plans: z
    .array(
      z.object({
        id: z.string().max(40),
        name: z.string().max(60),
        monthlyUsd: z.number().nullable(),
        monthlyInr: z.number().nullable(),
        agentMinutes: z.number().nullable(),
        targetCaps: z.number().nullable(),
        memberSeats: z.number().nullable(),
        deepAllowed: z.boolean(),
        selfServe: z.boolean(),
        availability: z.enum(["available", "beta", "gated", "roadmap", "unknown"]),
        ctaRoute: z.string().max(200).optional(),
      })
    )
    .max(8),
  note: z.string().max(500).optional(),
})

export const diagnosticStatusComponent = z.object({
  type: z.literal("diagnostic_status"),
  title: z.string().max(120),
  checkedAt: z.string().max(40),
  checks: z
    .array(
      z.object({
        id: z.string().max(60),
        label: z.string().max(160),
        status: z.enum(["pass", "fail", "unknown"]),
        detail: z.string().max(300).optional(),
        ctaRoute: z.string().max(200).optional(),
      })
    )
    .max(12),
})

export const taskStepsComponent = z.object({
  type: z.literal("task_steps"),
  steps: z
    .array(
      z.object({
        id: z.string().max(60),
        title: z.string().max(160),
        detail: z.string().max(400).optional(),
        status: z.enum(["pending", "active", "done", "blocked"]),
        ctaRoute: z.string().max(200).optional(),
      })
    )
    .max(12),
})

export const supportCasePreviewComponent = z.object({
  type: z.literal("support_case_preview"),
  proposalId: z.string().max(80),
  subject: z.string().max(160),
  summary: z.string().max(4000),
  replyDestination: z.string().max(320),
  includeDiagnostics: z.boolean(),
  includeTranscriptExcerpt: z.boolean(),
  expiresAt: z.string().max(40),
})

export const slotPickerComponent = z.object({
  type: z.literal("slot_picker"),
  proposalId: z.string().max(80).optional(),
  displayTimezone: z.string().max(60),
  slots: z
    .array(
      z.object({
        id: z.string().max(80),
        startsAt: z.string().max(40),
        endsAt: z.string().max(40),
      })
    )
    .max(40),
})

export const actionConfirmationComponent = z.object({
  type: z.literal("action_confirmation"),
  proposalId: z.string().max(80),
  title: z.string().max(160),
  description: z.string().max(1000),
  confirmLabel: z.string().max(40),
  expiresAt: z.string().max(40),
})

export const actionResultComponent = z.object({
  type: z.literal("action_result"),
  proposalId: z.string().max(80),
  status: myraOperationStatusSchema,
  title: z.string().max(160),
  detail: z.string().max(1000).optional(),
  reference: z.string().max(80).optional(),
})

export const guidedFlowComponent = z.object({
  type: z.literal("guided_flow"),
  flowId: z.string().max(60),
  flowTitle: z.string().max(160),
  stepIndex: z.number().int().min(0),
  status: z.enum(MYRA_FLOW_STATUSES),
  steps: z
    .array(
      z.object({
        id: z.string().max(60),
        title: z.string().max(160),
        status: z.enum(["pending", "active", "done", "blocked"]),
      })
    )
    .max(16),
})

export const instantSuggestionsComponent = z.object({
  type: z.literal("instant_suggestions"),
  suggestions: z
    .array(
      z.object({
        entryId: z.string().max(80),
        title: z.string().max(160),
        snippet: z.string().max(400),
        sourceUrl: urlSchema.optional(),
      })
    )
    .max(5),
})

export const memoryCardComponent = z.object({
  type: z.literal("memory_card"),
  entries: z.array(z.object({ key: z.string().max(60), label: z.string().max(160) })).max(20),
})

export const capabilityLineComponent = z.object({
  type: z.literal("capability_line"),
  canSee: z.array(z.string().max(120)).max(12),
  cannotSee: z.array(z.string().max(120)).max(12),
})

export const traceRefComponent = z.object({
  type: z.literal("trace_ref"),
  traceId: z.string().max(80),
})

export const myraComponentSchema = z.discriminatedUnion("type", [
  answerComponent,
  sourceLinkComponent,
  planComparisonComponent,
  diagnosticStatusComponent,
  taskStepsComponent,
  supportCasePreviewComponent,
  slotPickerComponent,
  actionConfirmationComponent,
  actionResultComponent,
  guidedFlowComponent,
  instantSuggestionsComponent,
  memoryCardComponent,
  capabilityLineComponent,
  traceRefComponent,
])
export type MyraComponent = z.infer<typeof myraComponentSchema>

// ─── Stream events (SSE `data:` payloads, one JSON object per event) ───────

export const myraStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), conversationId: z.string(), traceId: z.string() }),
  z.object({ type: z.literal("activity"), label: z.string().max(200) }),
  z.object({ type: z.literal("token"), text: z.string().max(2000) }),
  z.object({ type: z.literal("component"), component: myraComponentSchema }),
  z.object({
    type: z.literal("proposal"),
    proposal: z.object({
      id: z.string(),
      operationName: z.string(),
      title: z.string().max(160),
      description: z.string().max(1000),
      payloadPreview: z.record(z.string(), z.unknown()),
      expiresAt: z.string(),
    }),
  }),
  z.object({
    type: z.literal("operation"),
    operationId: z.string(),
    status: myraOperationStatusSchema,
  }),
  z.object({
    type: z.literal("done"),
    messageId: z.string(),
    taskRecord: z.lazy(() => taskRecordSchema),
  }),
  z.object({ type: z.literal("error"), error: myraErrorSchema }),
])
export type MyraStreamEvent = z.infer<typeof myraStreamEventSchema>

// ─── TaskRecord (persisted per turn; drives continuity + eval) ─────────────

export const taskRecordSchema = z.object({
  intent: z.string().max(80),
  toolsUsed: z.array(z.enum(MYRA_TOOL_NAMES)).max(16),
  outcome: z.enum([
    "answered",
    "abstained",
    "escalated",
    "action_proposed",
    "action_done",
    "error",
  ]),
  unresolved: z.boolean(),
  nextStep: z.string().max(300).optional(),
})
export type TaskRecord = z.infer<typeof taskRecordSchema>

// ─── API request/response payloads ─────────────────────────────────────────

export const postMessageRequestSchema = z
  .object({
    conversationId: z.string().max(80).optional(),
    text: z.string().min(1).max(4000),
    routeContext: z.string().max(120).optional(),
    surface: myraSurfaceSchema,
  })
  .strict()

export const suggestRequestSchema = z
  .object({
    text: z.string().min(2).max(300),
    surface: myraSurfaceSchema,
    routeContext: z.string().max(120).optional(),
  })
  .strict()

export const confirmProposalRequestSchema = z
  .object({ proposalId: z.string().max(80) })
  .strict()

export const submitCasePayloadSchema = z
  .object({
    subject: z.string().min(4).max(160),
    summary: z.string().min(10).max(4000),
    includeDiagnostics: z.boolean().default(false),
    includeTranscriptExcerpt: z.boolean().default(false),
    // Public submitters only: reply destination verified before send.
    replyEmail: z.email().max(320).optional(),
  })
  .strict()
export type SubmitCasePayload = z.infer<typeof submitCasePayloadSchema>

export const bookDemoPayloadSchema = z
  .object({
    slotStart: z.string().datetime({ offset: true }),
    timezone: z.string().min(2).max(60),
    name: z.string().min(1).max(120),
    email: z.email().max(320),
    context: z.string().max(2000).optional(),
  })
  .strict()
export type BookDemoPayload = z.infer<typeof bookDemoPayloadSchema>

export const caseReplyRequestSchema = z
  .object({ body: z.string().min(1).max(4000) })
  .strict()

export const identityRequestSchema = z
  .object({
    email: z.email().max(320),
    purpose: z.enum(["support_case", "demo_booking"]),
    publicSessionId: z.string().max(80).optional(),
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict()

export const identityConfirmSchema = z
  .object({
    email: z.email().max(320),
    purpose: z.enum(["support_case", "demo_booking"]),
    code: z.string().min(4).max(12),
  })
  .strict()

export const demoSlotsRequestSchema = z
  .object({
    timezone: z.string().min(2).max(60),
    // YYYY-MM-DD window start; server clamps to the booking horizon.
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()

export const manageDemoRequestSchema = z
  .object({
    action: z.enum(["cancel", "reschedule"]),
    newSlotStart: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

// ─── Copy constants (exact strings — keep in sync with spec §6/§7) ─────────

export const MYRA_COPY = {
  header: "Myra · AI support",
  opener:
    "I'm Myra, LyraShield's AI support agent. I can explain the product, help with setup or connect you with a person.",
  talkToPerson: "Talk to a person",
  caseDraft: "Review what we'll send to support.",
  caseSaved: (ref: string) => `Your request is saved as ${ref}.`,
  caseOffline:
    "No one is available for live chat right now. Your request is in the support queue.",
  caseDeliveryProblem:
    "Your request is saved, but the notification has not been delivered yet.",
  contactFallback: "You can also contact support through our support page.",
  demoConfirmed: (when: string) => `Your demo is booked for ${when}.`,
  demoMeetPending: "Your booking is confirmed. We are still preparing the Meet link.",
  demoUnknown:
    "We are checking whether your booking went through. You do not need to submit it again.",
  demoConflict: "That time is no longer available. Choose another slot.",
  demoNoSlots: "There are no open slots in this window. Request a time instead.",
  demoFailure: "We could not complete the booking. Your details are still in the form.",
  toolPageDisclosure:
    "Messages sent to Myra are processed by our support service. Your tool inputs stay in your browser unless you choose to share them.",
  demoLimit:
    "A demo is a product walkthrough. Testing your app requires separate authorization and setup.",
} as const

// ─── Limits and budgets (founder-resolved, spec §11) ───────────────────────

export const MYRA_LIMITS = {
  maxToolStepsPerTurn: 6,
  maxOutputTokensPerTurn: 4000,
  monthlyBudgetUsd: 50,
  messageMaxChars: 4000,
  conversationRetentionDays: 30,
  caseRetentionDays: 365,
  bookingRetentionDays: 365,
  proposalTtlMinutes: 15,
  publicSessionTtlDays: 30,
  identityCodeTtlMinutes: 15,
  identityCodeMaxAttempts: 5,
  demo: {
    durationMinutes: 30,
    bufferMinutes: 15,
    minNoticeHours: 24,
    horizonDays: 14,
    hostTimezone: "Asia/Kolkata",
    hostStartHour: 15, // IST weekdays 15:00–20:00
    hostEndHour: 20,
    organizerEmail: "ankit@lyrashieldai.com",
  },
} as const
