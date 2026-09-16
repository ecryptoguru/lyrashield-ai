/**
 * Task loop (spec §13.1): classify intent → run permitted tools (≤6 steps)
 * → provider.generate → emit MyraStreamEvent sequence. Deterministic code
 * owns tool selection, permission checks and verification; the model only
 * explains.
 */
import { randomBytes } from "node:crypto"
import { MYRA_LIMITS } from "../contracts"
import type { BookingRequest, MyraStreamEvent, MyraToolName, TaskRecord } from "../contracts"
import {
  checkBudget,
  maximumTurnCostUsd,
  recordCost,
  reserveGenerationBudget,
  settleGenerationBudget,
} from "./budget"
import { auditEvent } from "./audit"
import { toMyraError } from "./errors"
import { getProvider, sanitizeAnswerMarkdown } from "./provider"
import type { ModelProvider, ToolCallOutput } from "./provider"
import { runTool } from "./tools/registry"
import type { MyraToolContext, MyraToolResult, ProposalSummary } from "./tools/types"
import { withOwnerScope } from "./db"
import { suggestFlows } from "../flows"
import { routeAllowedForPrincipal } from "../route-manifest"
import { readOwnBookings } from "./tools/demo"
import { sanitizeInstructionInput } from "@lyrashield/security"

export interface LoopArgs {
  ctx: MyraToolContext
  text: string
  routeContext?: string | null
  /** Pre-allocated assistant message id — carried by the done event. */
  assistantMessageId: string
  traceId: string
  provider?: ModelProvider
  sessionMemory?: Record<string, string>
  /** Structured slot-picker submission — drives book_demo without text parsing. */
  bookingRequest?: BookingRequest
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/
const NAME_RE = /(?:my name is|i am|i'm|this is)\s+([A-Za-z][A-Za-z .'-]{1,60})/i

/**
 * Foreign-resource asks. Deliberately narrow: "add another user to my
 * workspace" or "switch to another account" are legitimate self-service
 * requests — the pattern only fires on possessive third-party phrasing
 * (their/someone else's/another workspace's) attached to a data noun, or an
 * explicit `ws_*` id that isn't the caller's own.
 */
const FOREIGN_ID_RE = /\bws_[a-z0-9_]+\b/gi
const FOREIGN_ASK_RE =
  /\b(their|someone else'?s|another|other)\s+(workspace|account|org|user'?s?|plan'?s?|sponsor'?s?)\b[^.?\n]{0,80}\b(data|scan|result|finding|plan|billing|sponsor|case|booking|usage|minutes|detail|status)\b/i
const POSSESSIVE_FOREIGN_RE =
  /\b(their|someone else'?s)\s+(workspace|account|plan|sponsor|billing|scan|booking|case)\b/i

function isForeignResourceAsk(text: string, ownWorkspaceId: string | null): boolean {
  for (const m of text.matchAll(FOREIGN_ID_RE)) {
    const id = m[0]
    if (ownWorkspaceId && id !== ownWorkspaceId) return true
    if (!ownWorkspaceId) return true // anonymous callers have no workspace
  }
  return FOREIGN_ASK_RE.test(text) || POSSESSIVE_FOREIGN_RE.test(text)
}

export function classifyIntent(text: string, isUser: boolean): string {
  const t = text.toLowerCase()
  if (
    /\b(meet link|booking|booked|did it go|went through|timed? ?out|reschedul|demo.{0,20}(status|link|confirm))\b/.test(
      t
    )
  ) {
    return "demo_status"
  }
  if (/\b(demo|book a (call|demo)|walkthrough|talk to sales|see it live)\b/.test(t)) {
    return "demo"
  }
  if (
    /\b(continue|resume|pick up|carry on)\b.{0,40}\b(flow|left off|check)\b|\bguided flow\b/.test(t)
  ) {
    return "flow_resume"
  }
  if (
    /\b(human|person|real (support|person)|speak to (someone|a person)|talk to a person|escalate|support case|contact support)\b/.test(
      t
    )
  ) {
    return "support_case"
  }
  if (
    /\b(remember|forget (?:that|what|everything)|my timezone|preferred (timezone|locale|depth))\b/.test(
      t
    )
  ) {
    return "memory"
  }
  if (
    isUser &&
    /\b(won'?t start|can'?t start|not starting|stuck|scan fails|scan failed)\b/.test(t)
  ) {
    return "flow_start"
  }
  if (
    isUser &&
    /\b(my (plan|minutes|balance|trial)|minutes left|remaining minutes|my usage|trial (minutes|balance|allowance)|how many (agent[- ])?minutes|entitlement)\b/.test(
      t
    )
  ) {
    return "account"
  }
  if (/\b(price|pricing|plans?|cost|how much|subscription|minute pack|overage|compare)\b/.test(t)) {
    return "catalog"
  }
  if (/\b(inconclusive|not proven|unverified|evidence state)\b/.test(t)) return "evidence"
  if (isUser && /\b(scan|finding|result|detected|verified|verdict|status)\b/.test(t)) {
    return "diagnostics"
  }
  return "help"
}

const ACTIVITY: Record<string, string> = {
  catalog: "Checking the current catalog.",
  account: "Checking your account's available minutes.",
  diagnostics: "Checking your scan and connection status.",
  flow_start: "Starting a guided check.",
  flow_resume: "Resuming your guided check.",
  demo: "Preparing demo slots.",
  demo_status: "Checking whether your booking went through.",
  support_case: "Preparing your case draft.",
  memory: "Checking saved preferences.",
  help: "Looking up documentation.",
  evidence: "Looking up documentation.",
}

interface StepOutcome {
  toolOutputs: ToolCallOutput[]
  components: NonNullable<MyraToolResult["components"]>
  proposals: ProposalSummary[]
  toolsUsed: MyraToolName[]
  aborted?: MyraStreamEvent // terminal event to yield instead of continuing
}

type RunStep = (name: MyraToolName, input: unknown) => Promise<MyraToolResult | null>

async function runDemoIntent(
  text: string,
  step: StepOutcome,
  run: RunStep,
  bookingRequest?: BookingRequest
): Promise<void> {
  // Structured slot-picker submission (item 1.5): fields arrive validated by
  // postMessageRequestSchema, so the booking proposal runs directly — no
  // name/email extraction from free text, no slot list needed.
  if (bookingRequest) {
    await run("book_demo", {
      slotStart: bookingRequest.slotStart,
      timezone: bookingRequest.timezone,
      name: bookingRequest.name,
      email: bookingRequest.email,
      ...(bookingRequest.context ? { context: bookingRequest.context } : {}),
    }).catch((e) => {
      // Anonymous attendees without a verified email keep the existing
      // verification-required flow instead of a hard error.
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        (e as { code: string }).code === "VERIFICATION_REQUIRED"
      ) {
        step.toolOutputs.push({
          name: "book_demo",
          output: { verificationRequired: true },
        })
        return null
      }
      throw e
    })
    return
  }
  const timezone = "UTC"
  await run("get_demo_slots", {
    timezone,
    from: new Date().toISOString().slice(0, 10),
  })
  // Regex fallback for plain text: only draft a booking proposal when the
  // message already carries an explicit slot instant plus attendee identity —
  // never invent a slot.
  const email = EMAIL_RE.exec(text)?.[0]
  const name = NAME_RE.exec(text)?.[1]?.trim()
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(text)?.[0]
  if (email && name && iso) {
    await run("book_demo", {
      slotStart: new Date(iso).toISOString(),
      timezone,
      name,
      email,
    }).catch(() => null)
  }
}

async function runDemoStatusIntent(ctx: MyraToolContext, step: StepOutcome): Promise<void> {
  // Own-booking read + outcome-unknown reconcile, then the provider
  // explains the state. Never a second insert, never a duplicate.
  const bookings = await readOwnBookings(ctx)
  step.toolOutputs.push({
    name: "manage_own_demo",
    output: { bookings },
  })
}

async function runFlowResumeIntent(
  ctx: MyraToolContext,
  db: MyraToolContext["db"],
  run: RunStep
): Promise<void> {
  const active = ctx.conversationId
    ? await withOwnerScope(
        ctx.principal,
        (tx) =>
          tx.myraFlowSession.findFirst({
            where: { conversationId: ctx.conversationId!, status: "ACTIVE" },
            orderBy: { createdAt: "desc" },
          }),
        db
      ).catch(() => null)
    : null
  if (active) {
    // start_guided_flow resumes the session and re-validates workspace.
    await run("start_guided_flow", { flowId: active.flowId })
  } else {
    await run("verify_resolution", {})
  }
}

async function runSupportCaseIntent(text: string, step: StepOutcome, run: RunStep): Promise<void> {
  const subject = text.split(/\n/)[0]!.slice(0, 120) || "Support request"
  await run("propose_support_case", {
    subject,
    summary: text.slice(0, 4000),
    includeDiagnostics: false,
    includeTranscriptExcerpt: false,
  }).catch((e) => {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "VERIFICATION_REQUIRED"
    ) {
      step.toolOutputs.push({
        name: "propose_support_case",
        output: { verificationRequired: true },
      })
      return null
    }
    throw e
  })
}

async function runMemoryIntent(text: string, run: RunStep): Promise<void> {
  if (/\bforget (?:that|what|everything)\b/i.test(text)) {
    await run("clear_memory", {})
    return
  }
  const tz = /timezone[^\n]{0,40}?(?:to|is|:)\s*([A-Za-z_]+\/[A-Za-z_]+)/i.exec(text)?.[1]
  const depth = /\b(terse|detailed)\b/i.exec(text)?.[1]?.toLowerCase()
  if (/\bremember|set\b/i.test(text) && (tz || depth)) {
    if (tz) await run("write_memory", { key: "preferred_timezone", value: tz })
    if (depth) await run("write_memory", { key: "preferred_depth", value: depth })
  }
  await run("read_memory", {})
}

export async function* runTaskLoop(args: LoopArgs): AsyncGenerator<MyraStreamEvent> {
  const { ctx, text, assistantMessageId, traceId } = args
  const provider = args.provider ?? getProvider()
  const db = ctx.db

  yield { type: "ready", conversationId: ctx.conversationId ?? "", traceId }

  // Takeover guard — no generation while a person holds the conversation.
  if (ctx.conversationId) {
    const conversation = await withOwnerScope(
      ctx.principal,
      (tx) =>
        tx.myraConversation.findUnique({
          where: { id: ctx.conversationId! },
          select: { state: true, humanTakeoverAt: true },
        }),
      db
    )
    if (conversation?.humanTakeoverAt || conversation?.state === "TAKEOVER") {
      yield {
        type: "error",
        error: { code: "TAKEOVER_ACTIVE", message: "A person has taken over this conversation." },
      }
      return
    }
  }

  const isUser = ctx.principal.kind === "user"

  // Cross-boundary asks are denied before any tool runs — a workspace id the
  // caller named that isn't their own, or "their/another workspace's" state.
  // The denial never confirms whether the target exists.
  if (isForeignResourceAsk(text, ctx.workspaceId)) {
    yield {
      type: "error",
      error: {
        code: "FORBIDDEN",
        message: "I can only look at your own workspace and account.",
      },
    }
    return
  }

  // A structured slot-picker submission is a demo action regardless of the
  // accompanying text — bypass classification so the request always reaches
  // book_demo.
  const intent = args.bookingRequest ? "demo" : classifyIntent(text, isUser)
  const step: StepOutcome = { toolOutputs: [], components: [], proposals: [], toolsUsed: [] }
  const budget = await checkBudget(db)

  const activity = ACTIVITY[intent]
  if (activity) yield { type: "activity", label: activity }

  const run = async (name: MyraToolName, input: unknown) => {
    if (step.toolsUsed.length >= MYRA_LIMITS.maxToolStepsPerTurn) return null
    const result = await runTool(name, ctx, input)
    step.toolsUsed.push(name)
    step.toolOutputs.push({ name, output: result.data })
    if (result.components) step.components.push(...result.components)
    if (result.proposals) step.proposals.push(...result.proposals)
    return result
  }

  try {
    switch (intent) {
      case "catalog":
        await run("read_product_catalog", {})
        break
      case "account":
        await run("get_my_context", {})
        break
      case "diagnostics":
        await run("get_my_context", {})
        await run("get_scan_status", {})
        await run("get_connection_health", {})
        break
      case "flow_start": {
        const suggested = suggestFlows(ctx.routeContext ?? null)
        const flow = suggested.find((f) => f.id === "scan_wont_start") ?? suggested[0]
        if (flow) {
          await run("start_guided_flow", { flowId: flow.id })
        } else {
          await run("get_my_context", {})
          await run("get_connection_health", {})
        }
        break
      }
      case "demo":
        await runDemoIntent(text, step, run, args.bookingRequest)
        break
      case "demo_status":
        await runDemoStatusIntent(ctx, step)
        break
      case "flow_resume":
        await runFlowResumeIntent(ctx, db, run)
        break
      case "support_case":
        await runSupportCaseIntent(text, step, run)
        break
      case "memory":
        await runMemoryIntent(text, run)
        break
      case "help":
      case "evidence":
      default:
        await run("search_public_help", { query: text })
        break
    }
  } catch (e) {
    yield { type: "error", error: toMyraError(e) }
    return
  }

  // Emit tool-rendered components and proposals before the prose.
  for (const component of step.components) yield { type: "component", component }
  for (const proposal of step.proposals) {
    yield {
      type: "proposal",
      proposal: {
        id: proposal.id,
        operationName: proposal.operationName,
        title: proposal.title,
        description: proposal.description,
        payloadPreview: proposal.payloadPreview,
        expiresAt: proposal.expiresAt,
      },
    }
  }

  // Prose answer — budget-gated. Deterministic intents keep working when
  // generation is off: a fixed explanation replaces the model call.
  let answerText: string
  const verification = step.toolOutputs.find((t) => t.output.verificationRequired === true)
  if (!budget.allowed && provider.name !== "mock") {
    yield {
      type: "error",
      error: { code: "BUDGET_EXHAUSTED", message: "Myra is at its usage limit for now." },
    }
    return
  }
  try {
    // The provider only receives a route context the caller's role may
    // actually see — a VIEWER on /dashboard/billing leaks nothing upstream.
    const safeRouteContext =
      ctx.routeContext &&
      routeAllowedForPrincipal(
        ctx.routeContext,
        ctx.principal,
        ctx.surface === "DASHBOARD" ? "app" : "marketing"
      )
        ? ctx.routeContext
        : null
    const tier = ["diagnostics", "flow_start", "flow_resume", "support_case", "evidence"].includes(
      intent
    )
      ? "deep"
      : "fast"
    if (provider.name === "azure") {
      await reserveGenerationBudget(traceId, maximumTurnCostUsd(tier))
    }
    const generated = await provider.generate({
      system: systemPrompt(ctx),
      messages: [{ role: "user", content: sanitizeInstructionInput(text) }],
      tier,
      context: {
        intent,
        toolOutputs: step.toolOutputs,
        routeContext: safeRouteContext,
        sessionMemory: args.sessionMemory,
      },
    })
    answerText = sanitizeAnswerMarkdown(generated.text)
    if (provider.name === "azure") {
      await settleGenerationBudget(traceId, generated.usage.costUsd)
    }
    if (generated.usage.costUsd > 0) {
      await recordCost(
        traceId,
        generated.usage.costUsd,
        {
          accountId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
          publicSessionId:
            ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
        },
        db
      )
    }
  } catch (e) {
    yield { type: "error", error: toMyraError(e) }
    return
  }
  if (verification) {
    answerText +=
      verification.name === "book_demo"
        ? " Verify your email to book the demo — I'll send a 6-digit code."
        : " Verify your reply email first — I'll send a 6-digit code."
  }

  for (const chunk of chunkText(answerText)) {
    yield { type: "token", text: chunk }
  }

  const taskRecord = buildTaskRecord(intent, step, answerText)
  yield { type: "done", messageId: assistantMessageId, taskRecord }

  await auditEvent(
    isUser ? "user" : "public_session",
    {
      accountId: ctx.principal.kind === "user" ? ctx.principal.accountId : null,
      publicSessionId: ctx.principal.kind === "anonymous" ? ctx.principal.publicSessionId : null,
      workspaceId: ctx.workspaceId,
      action: "myra.turn",
      resourceType: "conversation",
      resourceId: ctx.conversationId,
      metadata: {
        traceId,
        intent,
        outcome: taskRecord.outcome,
        toolsUsed: taskRecord.toolsUsed,
        unresolved: taskRecord.unresolved,
      },
    },
    db
  )
}

function buildTaskRecord(intent: string, step: StepOutcome, answer: string): TaskRecord {
  const proposed = step.proposals.length > 0
  const abstained =
    intent === "help" &&
    step.toolOutputs.some((t) => t.name === "search_public_help" && t.output.abstained === true)
  return {
    intent,
    toolsUsed: step.toolsUsed,
    outcome: proposed ? "action_proposed" : abstained ? "abstained" : "answered",
    unresolved: abstained,
    ...(abstained ? { nextStep: "Offer the support case composer." } : {}),
    ...(answer.length === 0 && !proposed ? { nextStep: "Clarify the request." } : {}),
  }
}

function chunkText(text: string): string[] {
  if (text.length <= 600) return text ? [text] : []
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += 600) chunks.push(text.slice(i, i + 600))
  return chunks
}

function systemPrompt(ctx: MyraToolContext): string {
  return [
    "You are Myra, LyraShield AI's support agent. Answer directly and briefly.",
    "Use only retrieved sources and tool results for facts; cite the source used.",
    "Never reveal findings content, credentials, other accounts or internal data.",
    "When unsure or unsourced, say so and offer to connect the user with a person.",
    `Surface: ${ctx.surface}. Principal: ${ctx.principal.kind}.`,
  ].join("\n")
}

export function newTraceId(): string {
  return `myra_${randomBytes(12).toString("hex")}`
}
