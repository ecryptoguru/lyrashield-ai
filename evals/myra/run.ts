#!/usr/bin/env tsx
/**
 * evals/myra/run.ts — deterministic offline eval runner for Myra.
 *
 * Loads scenario fixtures from ./scenarios/*.json, drives the server
 * pipeline OFFLINE against FakeMyraStore + MockProvider (no database, no
 * network, no model credentials) and asserts the deterministic expectations
 * from spec §10/§13.8: permission denials, proposal-required writes, payload
 * binding, overlap rules, sanitization and memory scoping.
 *
 * Run (no new deps — tsx already in the workspace via @lyrashield/db):
 *   pnpm --filter @lyrashield/db exec tsx evals/myra/run.ts
 *   pnpm --filter @lyrashield/db exec tsx evals/myra/run.ts --runs=3
 *
 * Flags:
 *   --runs=N            execute each runnable scenario N times (default 1)
 *   --scenario=a,b      run only matching scenario ids
 *   --allow-blocked     exit 0 even when the server pipeline is unavailable
 *
 * Exit codes: 0 = every runnable scenario passed (skips allowed);
 *             1 = at least one failure, or the pipeline was blocked and
 *                 --allow-blocked was not given.
 *
 * Pinned server API (built concurrently under packages/myra/src/server):
 *   handleMessage({ principal, db, provider, input, surface, routeContext })
 *     → AsyncIterable<MyraStreamEvent> | { events } | MyraStreamEvent[]
 *   confirmProposal({ proposalId, principal, db, provider, payloadOverride? })
 *     → result | throws { code }
 *   suggest / handleSuggest ({ text, principal, db, surface, routeContext })
 *     → optional, only for the `suggest` action
 *   resolveMyraRequest — detected but not invoked: the harness builds the
 *     MyraPrincipal directly from `persona` since its transport shape is
 *     server-owned.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  myraStreamEventSchema,
  type MyraPrincipal,
  type MyraStreamEvent,
} from "../../packages/myra/src/contracts"
import { isManifestRoute } from "../../packages/myra/src/route-manifest"
import { sanitizeLinkHref, screenSecrets } from "../../packages/myra/src/sanitize"
import {
  MockProvider,
  seedStore,
  type FakeMyraStore,
  type ScenarioSetup,
} from "./fakes"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCENARIO_DIR = join(HERE, "scenarios")
const REPORT_PATH = join(HERE, "last-report.json")

// ─── Scenario fixture shape ────────────────────────────────────────────────

const CATEGORIES = ["knowledge", "diagnostic", "permission", "action", "handoff", "accessibility"] as const
const PERSONAS = ["anonymous", "user", "operator"] as const
const OUTCOMES = ["answered", "abstained", "escalated", "action_proposed", "action_done", "error"] as const

interface ScenarioAction {
  type: "confirm" | "revokeRole" | "switchWorkspace" | "takeover" | "message" | "suggest"
  proposalId?: string
  /** Re-confirm with a mutated payload — must trigger a NEW confirmation. */
  mutatePayload?: Record<string, unknown>
  workspaceId?: string
  conversationId?: string
  text?: string
}

interface ScenarioExpect {
  outcome?: string | string[]
  toolsUsed?: string[] // subset: every listed tool must appear
  toolsNotUsed?: string[] // none of these may appear
  mustContain?: string[] // substrings in the user-visible surface text
  mustNotContain?: string[] // absent from surface text, provider payloads, stored messages and memory
  components?: string[] // component types that must be rendered
  proposalRequired?: boolean
  denied?: boolean // turn or a required action was denied with an authz/proposal code
  sanitized?: boolean // all emitted links/URLs pass sanitizeLinkHref; ctaRoutes resolve in the manifest
  memoryKeysOnly?: boolean // every stored memory key is allowlisted
  bookingCount?: number
  caseCount?: number
  completedOperationCount?: number
  providerCalls?: number
  maxCtaComponents?: number
  anyOf?: ScenarioExpect[] // at least one alternative must fully hold
}

interface Scenario {
  id: string
  title: string
  category: (typeof CATEGORIES)[number]
  persona: (typeof PERSONAS)[number]
  requiresProvider?: boolean
  surface?: "MARKETING" | "DASHBOARD"
  routeContext?: string
  setup?: ScenarioSetup
  input: string
  actions?: ScenarioAction[]
  expect: ScenarioExpect
  note?: string
}

// ─── Pipeline loading ──────────────────────────────────────────────────────

interface Pipeline {
  /** Normalized message entry — wraps handleMessage or runTaskLoop. */
  handleMessage: (args: MessageArgs) => Promise<unknown>
  /** Normalized confirm — wraps confirmProposal or confirm+executor map. */
  confirmProposal: (args: ConfirmArgs) => Promise<unknown>
  suggest?: (args: Record<string, unknown>) => Promise<unknown> | unknown
  /** Which server entry the adapter bound to, for the report. */
  bound: string[]
}

interface MessageArgs {
  principal: MyraPrincipal
  db: FakeMyraStore
  provider: MockProvider
  input: { text: string; conversationId?: string }
  surface: string
  routeContext: string | null
  /** External-boundary seams (billing fakes, notification flag). */
  deps?: EvalDeps
}

interface ConfirmArgs {
  proposalId: string
  principal: MyraPrincipal
  db: FakeMyraStore
  provider: MockProvider
  conversationId: string | null
  workspaceId: string | null
  /** Tamper the stored payload before confirming — must trigger a NEW confirmation. */
  mutatePayload?: Record<string, unknown>
  deps?: EvalDeps
}

/** Injected seams — billing reads scenario setup, notifications honor the flag. */
interface EvalDeps {
  resolveAccountBilling?: (accountId: string, db?: unknown) => Promise<unknown>
  getAccountTrialState?: (accountId: string) => Promise<unknown>
  getUsageBalance?: (accountId: string, opts?: unknown) => Promise<unknown>
  evaluateScanEntitlement?: (opts: unknown) => Promise<unknown>
  sendNotification?: (
    channel: string,
    notification: Record<string, unknown>,
    recipients: string[]
  ) => Promise<boolean>
}

/** Build deps from scenario setup + store flags. */
function evalDeps(store: FakeMyraStore, setup?: ScenarioSetup): EvalDeps {
  const trialMinutes = setup?.account?.trialMinutesRemaining ?? 0
  return {
    resolveAccountBilling: async () => ({ effectivePlan: "FREE" }),
    getAccountTrialState: async () => ({
      isActive: trialMinutes > 0,
      isExpired: false,
      daysLeft: 5,
      minutesLeft: trialMinutes,
      startedAt: new Date(),
      targetCap: 3,
    }),
    getUsageBalance: async () => ({ totalRemaining: trialMinutes }),
    evaluateScanEntitlement: async () => ({ allowed: true }),
    sendNotification: async (_channel, notification, _recipients) => {
      store.notifications.push({
        caseId: String((notification as { metadata?: { caseId?: string } }).metadata?.caseId ?? ""),
        status: store.flags.notificationFails ? "failed" : "delivered",
        error: store.flags.notificationFails ? "simulated failure" : null,
      })
      return !store.flags.notificationFails
    },
  }
}

interface PipelineStatus {
  pipeline: Pipeline | null
  missing: string[]
  error?: string
}

type AnyFn = (...args: never[]) => unknown

async function tryImport(path: string): Promise<Record<string, AnyFn> | null> {
  try {
    return (await import(path)) as Record<string, AnyFn>
  } catch {
    return null
  }
}

/**
 * Executor resolution for confirmed writes. Prefer a server-provided map
 * (`executorFor`/`EXECUTORS`); otherwise bind the known tool executors from
 * their modules. If neither exists, confirm actions report a clear miss.
 */
async function resolveExecutorFor(
  serverMod: Record<string, AnyFn>
): Promise<(operationName: string) => AnyFn | null> {
  const named =
    (serverMod.executorFor as unknown as (n: string) => AnyFn | null) ??
    (serverMod.EXECUTORS as unknown as Record<string, AnyFn> | undefined)
  if (typeof named === "function") return named
  if (named && typeof named === "object") return (n) => (named as Record<string, AnyFn>)[n] ?? null

  // Known executor functions — present on the merged module surface.
  const direct: Record<string, string> = {
    submit_support_case: "executeSubmitSupportCase",
    book_demo: "executeBookDemo",
    manage_own_demo: "executeManageDemo",
  }
  const executors: Record<string, AnyFn> = {}
  for (const [op, fnName] of Object.entries(direct)) {
    if (typeof serverMod[fnName] === "function") executors[op] = serverMod[fnName]!
  }
  return (n) => executors[n] ?? null
}

const SERVER_MODULES = [
  "../../packages/myra/src/server/service.ts",
  "../../packages/myra/src/server/loop.ts",
  "../../packages/myra/src/server/operations.ts",
  "../../packages/myra/src/server/kb.ts",
  "../../packages/myra/src/server/tools/help.ts",
  "../../packages/myra/src/server/tools/cases.ts",
  "../../packages/myra/src/server/tools/demo.ts",
] as const

/**
 * Load whatever server surface exists and merge the exports. The barrel
 * (server/index.ts) is deliberately NOT imported: it transitively loads
 * context.ts → @lyrashield/auth → better-auth init, which opens a real DB
 * connection at module scope and would crash the offline runner.
 * service.ts is safe to import — its prisma access happens at call time,
 * and its fns gain the runner's fake via the arity-based adapters below.
 */
async function loadPipeline(): Promise<PipelineStatus> {
  let mod: Record<string, AnyFn> = {}
  let imported = 0
  for (const path of SERVER_MODULES) {
    const m = await tryImport(path)
    if (m) {
      imported++
      mod = { ...mod, ...m }
    }
  }
  if (imported === 0) {
    return {
      pipeline: null,
      missing: ["handleMessage|runTaskLoop", "confirmProposal|confirm"],
      error: `no server modules found under packages/myra/src/server — pipeline not landed yet`,
    }
  }

  const bound: string[] = []
  const missing: string[] = []

  // Message entry: the pinned handleMessage once it accepts a db/deps arg
  // (arity ≥ 3); until then drive the injectable task loop directly with the
  // same pre-screening service.ts applies (screenSecrets before the model).
  let handleMessage: Pipeline["handleMessage"] | undefined
  if (typeof mod.handleMessage === "function" && mod.handleMessage.length >= 3) {
    bound.push("handleMessage(db-injectable)")
    handleMessage = async (args) =>
      mod.handleMessage!(
        {
          principal: args.principal,
          workspaceId: args.principal.kind === "user" ? (args.principal.workspaceId ?? null) : null,
          role: args.principal.kind === "user" ? args.principal.role : null,
        } as never,
        {
          conversationId: args.input.conversationId,
          text: args.input.text,
          routeContext: args.routeContext ?? undefined,
          surface: args.surface,
        } as never,
        { db: args.db, provider: args.provider } as never
      )
  } else if (typeof mod.runTaskLoop === "function") {
    bound.push("runTaskLoop")
    handleMessage = async (args) => {
      // Mirror service.ts handleMessage: screen secrets before anything sees
      // the raw text, then run the bounded task loop.
      const screened = screenSecrets(args.input.text).text
      return mod.runTaskLoop!({
        ctx: {
          principal: args.principal,
          surface: args.surface,
          conversationId: args.input.conversationId ?? null,
          workspaceId:
            args.principal.kind === "user" ? (args.principal.workspaceId ?? null) : null,
          role: args.principal.kind === "user" ? args.principal.role : null,
          routeContext: args.routeContext,
          db: args.db,
          deps: args.deps,
        },
        text: screened,
        routeContext: args.routeContext,
        assistantMessageId: `msg_eval_${Math.random().toString(36).slice(2, 10)}`,
        traceId: `tr_eval_${Math.random().toString(36).slice(2, 10)}`,
        provider: args.provider,
      } as never)
    }
  } else {
    missing.push("handleMessage|runTaskLoop")
  }

  // Confirm entry: prefer the pinned confirmProposal once it takes a deps
  // arg (arity ≥ 3); until then use the confirmation engine's
  // confirm(ctx, proposalId, executor, db) with the tool executor map.
  let confirmProposal: Pipeline["confirmProposal"] | undefined
  if (typeof mod.confirmProposal === "function" && mod.confirmProposal.length >= 3) {
    bound.push("confirmProposal(db-injectable)")
    confirmProposal = async (args) =>
      mod.confirmProposal!(
        {
          principal: args.principal,
          workspaceId: args.workspaceId,
          role: args.principal.kind === "user" ? args.principal.role : null,
        } as never,
        args.proposalId as never,
        {
          db: args.db,
          provider: args.provider,
          ...(args.mutatePayload ? { payloadOverride: args.mutatePayload } : {}),
        } as never
      )
  } else if (typeof mod.confirm === "function") {
    bound.push("confirm")
    const executorFor = await resolveExecutorFor(mod)
    confirmProposal = async (args) => {
      if (args.mutatePayload) {
        // Post-preview tampering: change the stored payload so the engine's
        // input-hash comparison must reject with PROPOSAL_PAYLOAD_CHANGED.
        const row = args.db.myraOperation.rows.get(args.proposalId)
        if (row) row.payload = { ...(row.payload as object), ...args.mutatePayload }
      }
      const op = args.db.myraOperation.rows.get(args.proposalId)
      const executor = executorFor(String(op?.operationName ?? ""))
      if (!executor) {
        throw Object.assign(new Error(`no executor for ${String(op?.operationName)}`), {
          code: "NO_EXECUTOR",
        })
      }
      return mod.confirm!(
        {
          principal: args.principal,
          conversationId: args.conversationId,
          workspaceId: args.workspaceId,
          deps: args.deps,
        } as never,
        args.proposalId as never,
        executor as never,
        args.db as never
      )
    }
  } else {
    missing.push("confirmProposal|confirm")
  }

  // Suggest entry: a service-level suggest fn once it accepts db (arity ≥ 5
  // — current signature is (ctx, text, surface, routeContext)); until then
  // drive the instant_suggest tool runner with the fake db.
  let suggest: Pipeline["suggest"] | undefined
  const svcSuggest = (mod.suggest ?? mod.handleSuggest ?? mod.instantSuggest) as AnyFn | undefined
  if (typeof svcSuggest === "function" && svcSuggest.length >= 5) {
    bound.push("suggest(db-injectable)")
    suggest = async (a) => {
      const p = a.principal as MyraPrincipal
      return svcSuggest(
        {
          principal: p,
          workspaceId: p.kind === "user" ? (p.workspaceId ?? null) : null,
          role: p.kind === "user" ? p.role : null,
        } as never,
        a.text as never,
        a.surface as never,
        (a.routeContext ?? undefined) as never,
        { db: a.db } as never
      )
    }
  } else if (typeof mod.runInstantSuggest === "function") {
    bound.push("runInstantSuggest")
    const fn = mod.runInstantSuggest
    const kb = mod.searchKnowledge
    suggest = async (a) => {
      const p = a.principal as MyraPrincipal
      const toolCtx = {
        principal: p,
        surface: a.surface,
        conversationId: null,
        workspaceId: p.kind === "user" ? (p.workspaceId ?? null) : null,
        role: p.kind === "user" ? p.role : null,
        routeContext: a.routeContext,
        db: a.db,
      }
      try {
        return await fn(toolCtx as never, { text: a.text } as never)
      } catch (e) {
        // runInstantSuggest doesn't thread ctx.db into searchKnowledge yet —
        // a real-DB error degrades the path to retrieval only so the
        // sanitization assertions still run.
        const msg = e instanceof Error ? e.message : String(e)
        if (typeof kb !== "function" || !/P\d{4}|PrismaClient|queryRaw|database/i.test(msg)) {
          throw e
        }
        const hits = (await kb(
          a.principal as never,
          a.text as never,
          { limit: 3, role: toolCtx.role } as never,
          a.db as never
        )) as { entryId: string; title: string; snippet: string; sourceUrl: string | null }[]
        return {
          suggestions: hits.map((h) => ({
            entryId: h.entryId,
            title: h.title,
            snippet: h.snippet,
            sourceUrl: h.sourceUrl ?? undefined,
          })),
        }
      }
    }
  } else if (typeof mod.searchKnowledge === "function") {
    // Last resort: retrieval only (searchKnowledge takes an injectable db).
    // No suggestion shaping here — the harness asserts on the raw hits, so a
    // sanitization gap in the service still surfaces.
    bound.push("searchKnowledge")
    const fn = mod.searchKnowledge
    suggest = async (a) => ({
      suggestions: ((await fn(
        a.principal as never,
        a.text as never,
        {
          limit: 3,
          role:
            (a.principal as MyraPrincipal).kind === "user"
              ? (a.principal as { role?: string | null }).role
              : null,
        } as never,
        a.db as never
      )) as { entryId: string; title: string; snippet: string; sourceUrl: string | null }[]).map(
        (h) => ({
          entryId: h.entryId,
          title: h.title,
          snippet: h.snippet,
          sourceUrl: h.sourceUrl ?? undefined,
        })
      ),
    })
  }

  if (missing.length) return { pipeline: null, missing, error: `bound: ${bound.join(", ") || "none"}` }
  return { pipeline: { handleMessage: handleMessage!, confirmProposal: confirmProposal!, suggest, bound }, missing: [] }
}

// ─── Turn collection ───────────────────────────────────────────────────────

interface TurnResult {
  events: MyraStreamEvent[]
  invalidEvents: unknown[]
  /** Concatenated user-visible text: tokens + component payloads + proposals + errors. */
  surfaceText: string
  componentTypes: string[]
  toolsUsed: string[]
  outcome: string | null
  proposalCount: number
  denials: string[] // error codes seen on the turn or its actions
  /** Non-denial errors thrown by actions — a pipeline bug, always a failure. */
  actionErrors: string[]
}

const DENIAL_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "OWNERSHIP_MISMATCH",
  "PROPOSAL_EXPIRED",
  "PROPOSAL_PAYLOAD_CHANGED",
  "PROPOSAL_STATE_INVALID",
  "TAKEOVER_ACTIVE",
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "SLOT_UNAVAILABLE",
])

function newTurn(): TurnResult {
  return {
    events: [],
    invalidEvents: [],
    surfaceText: "",
    componentTypes: [],
    toolsUsed: [],
    outcome: null,
    proposalCount: 0,
    denials: [],
    actionErrors: [],
  }
}

async function collectEvents(ret: unknown): Promise<{ events: unknown[]; shapeError?: string }> {
  if (ret == null) return { events: [], shapeError: "handleMessage returned void" }
  if (typeof (ret as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const events: unknown[] = []
    for await (const e of ret as AsyncIterable<unknown>) events.push(e)
    return { events }
  }
  if (Array.isArray(ret)) return { events: ret }
  if (typeof ret === "object") {
    const inner = (ret as Record<string, unknown>).events
    if (Array.isArray(inner)) return { events: inner }
    if (inner && typeof (inner as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      return collectEvents(inner)
    }
  }
  return { events: [], shapeError: "unrecognized handleMessage return shape" }
}

/** Fold a raw event into the running turn result. */
function absorbEvent(turn: TurnResult, raw: unknown): void {
  const parsed = myraStreamEventSchema.safeParse(raw)
  if (!parsed.success) {
    turn.invalidEvents.push(raw)
    return
  }
  const event = parsed.data
  turn.events.push(event)
  switch (event.type) {
    case "token":
      turn.surfaceText += event.text + "\n"
      break
    case "component":
      turn.componentTypes.push(event.component.type)
      turn.surfaceText += JSON.stringify(event.component) + "\n"
      break
    case "proposal":
      turn.proposalCount += 1
      turn.surfaceText +=
        event.proposal.title + "\n" + event.proposal.description + "\n" +
        JSON.stringify(event.proposal.payloadPreview) + "\n"
      break
    case "operation":
      if (DENIAL_CODES.has(event.status)) turn.denials.push(event.status)
      break
    case "done":
      turn.outcome = event.taskRecord.outcome
      for (const t of event.taskRecord.toolsUsed) {
        if (!turn.toolsUsed.includes(t)) turn.toolsUsed.push(t)
      }
      break
    case "error":
      turn.surfaceText += event.error.message + "\n"
      if (DENIAL_CODES.has(event.error.code)) turn.denials.push(event.error.code)
      else if (!turn.outcome) turn.outcome = "error"
      break
    default:
      break
  }
}

async function runTurn(pipeline: Pipeline, args: MessageArgs): Promise<TurnResult> {
  const turn = newTurn()
  const { events, shapeError } = await collectEvents(await pipeline.handleMessage(args))
  if (shapeError) throw new Error(`handleMessage: ${shapeError}`)
  for (const e of events) absorbEvent(turn, e)
  return turn
}

function mergeTurn(into: TurnResult, from: TurnResult): void {
  into.events.push(...from.events)
  into.invalidEvents.push(...from.invalidEvents)
  into.surfaceText += from.surfaceText
  into.componentTypes.push(...from.componentTypes)
  into.proposalCount += from.proposalCount
  into.denials.push(...from.denials)
  into.actionErrors.push(...from.actionErrors)
  for (const t of from.toolsUsed) if (!into.toolsUsed.includes(t)) into.toolsUsed.push(t)
  if (from.outcome) into.outcome = from.outcome
}

// ─── Scenario execution ────────────────────────────────────────────────────

function principalFor(s: Scenario): MyraPrincipal {
  const accountId = s.setup?.account?.id ?? "acct_eval"
  const workspaceId = s.setup?.workspace?.id ?? "ws_eval"
  switch (s.persona) {
    case "anonymous":
      return { kind: "anonymous", publicSessionId: `pubsess_${s.id}` }
    case "user":
      return {
        kind: "user",
        accountId,
        sessionId: `sess_${s.id}`,
        workspaceId,
        role: s.setup?.role ?? "MEMBER",
      }
    case "operator":
      return { kind: "operator", accountId: `acct_op_${s.id}`, sessionId: `sess_op_${s.id}` }
  }
}

async function runAction(
  action: ScenarioAction,
  ctx: {
    pipeline: Pipeline
    principal: MyraPrincipal
    store: FakeMyraStore
    provider: MockProvider
    conversationId: string
    surface: string
    routeContext: string | null
    turn: TurnResult
    deps: EvalDeps
  }
): Promise<void> {
  const { pipeline, principal, store, provider } = ctx
  switch (action.type) {
    case "confirm": {
      if (!action.proposalId) throw new Error("confirm action needs proposalId")
      try {
        const res = (await pipeline.confirmProposal({
          proposalId: action.proposalId,
          principal,
          db: store,
          provider,
          conversationId: ctx.conversationId,
          workspaceId:
            principal.kind === "user" ? (principal.workspaceId ?? null) : null,
          deps: ctx.deps,
          ...(action.mutatePayload ? { mutatePayload: action.mutatePayload } : {}),
        })) as Record<string, unknown> | undefined
        const code =
          (res?.error as { code?: string } | undefined)?.code ??
          (res?.errorCode as string | undefined) ??
          (res?.code as string | undefined)
        if (code && DENIAL_CODES.has(code)) ctx.turn.denials.push(code)
        // Surface the returned outcome/component so mustContain sees the
        // approved copy (e.g. "still preparing the Meet link").
        if (res) ctx.turn.surfaceText += JSON.stringify(res) + "\n"
        if (res && typeof res === "object" && "component" in res) {
          const comp = (res as { component?: { type?: string } }).component
          if (comp?.type) ctx.turn.componentTypes.push(comp.type)
        }
      } catch (err) {
        const code =
          (err as { code?: string })?.code ??
          (err as { error?: { code?: string } })?.error?.code ??
          "THROWN"
        if (DENIAL_CODES.has(code)) ctx.turn.denials.push(code)
        else {
          const msg = err instanceof Error ? err.message : String(err)
          const prismaHit = /P\d{4}|PrismaClient|prisma\.|Can't reach database|authentication failed/i.test(
            msg
          )
          ctx.turn.actionErrors.push(
            prismaHit
              ? `confirm hit the real DB (path not db-injectable): ${code}`
              : `confirm threw non-denial error: ${code}`
          )
        }
      }
      return
    }
    case "revokeRole": {
      if (principal.kind === "user") principal.role = null
      return
    }
    case "switchWorkspace": {
      if (principal.kind === "user") {
        principal.workspaceId = action.workspaceId ?? "ws_other"
      }
      return
    }
    case "takeover": {
      store.takeOver(action.conversationId ?? ctx.conversationId)
      return
    }
    case "message": {
      if (!action.text) throw new Error("message action needs text")
      const t = await runTurn(pipeline, {
        principal,
        db: store,
        provider,
        input: { text: action.text, conversationId: ctx.conversationId },
        surface: ctx.surface,
        routeContext: ctx.routeContext,
        deps: ctx.deps,
      })
      mergeTurn(ctx.turn, t)
      return
    }
    case "suggest": {
      const fn = pipeline.suggest
      if (typeof fn !== "function") {
        throw new Error("suggest action needs a `suggest`/`handleSuggest` export (not present)")
      }
      const res = (await fn({
        text: action.text ?? "",
        principal,
        db: store,
        surface: ctx.surface,
        routeContext: ctx.routeContext,
      })) as
        | { suggestions?: unknown[]; components?: { type?: string; suggestions?: unknown[] }[] }
        | undefined
      // Accept both service shape ({suggestions}) and tool-result shape
      // ({components: [{type:"instant_suggestions", suggestions}]}).
      const suggestions: unknown[] = Array.isArray(res?.suggestions)
        ? res.suggestions
        : (res?.components ?? [])
            .filter((c) => c?.type === "instant_suggestions" || Array.isArray(c?.suggestions))
            .flatMap((c) => c.suggestions ?? [])
      ctx.turn.surfaceText += JSON.stringify(suggestions) + "\n"
      if (suggestions.length > 0) ctx.turn.componentTypes.push("instant_suggestions")
      return
    }
  }
}

// ─── Assertions ────────────────────────────────────────────────────────────

/** Raw [label](href) links the pipeline emitted — each href must sanitize. */
function rawLinkHrefs(text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]{0,200}\]\(([^)\s]{1,400})\)/g)].map((m) => m[1]!)
}

function ctaBearingComponentCount(events: MyraStreamEvent[]): number {
  let count = 0
  for (const e of events) {
    if (e.type !== "component") continue
    const c = e.component as Record<string, unknown>
    const hasInlineCta = JSON.stringify(c).includes('"ctaRoute"')
    const isActionCta = ["action_confirmation", "slot_picker", "support_case_preview"].includes(
      c.type as string
    )
    if (hasInlineCta || isActionCta) count += 1
  }
  return count
}

function evaluateExpect(
  expect: ScenarioExpect,
  turn: TurnResult,
  store: FakeMyraStore,
  provider: MockProvider,
  principal: MyraPrincipal,
  preRunRowIds: ReadonlySet<string>,
  providerCalls?: number
): string[] {
  const reasons: string[] = []

  if (expect.outcome !== undefined) {
    const allowed = Array.isArray(expect.outcome) ? expect.outcome : [expect.outcome]
    if (!turn.outcome) reasons.push(`outcome: no done/error event (expected ${allowed.join("|")})`)
    else if (!allowed.includes(turn.outcome))
      reasons.push(`outcome ${turn.outcome} not in [${allowed.join(", ")}]`)
  }

  for (const tool of expect.toolsUsed ?? []) {
    if (!turn.toolsUsed.includes(tool)) reasons.push(`expected tool ${tool} not used`)
  }
  for (const tool of expect.toolsNotUsed ?? []) {
    if (turn.toolsUsed.includes(tool)) reasons.push(`forbidden tool ${tool} was used`)
  }

  for (const s of expect.mustContain ?? []) {
    if (!turn.surfaceText.includes(s)) reasons.push(`surface text missing ${JSON.stringify(s)}`)
  }

  if (expect.mustNotContain?.length) {
    // Scope: what the user saw, what left for the provider, and what was
    // newly persisted this run (pre-seeded rows are fixture data — they
    // must not count as leakage). A leak anywhere is a leak.
    const newMessages = [...store.myraMessage.rows.values()]
      .filter((r) => !preRunRowIds.has(r.id))
      .map((r) => String(r.content ?? ""))
    const newMemory = [...store.myraMemory.rows.values()].filter(
      (r) => !preRunRowIds.has(r.id)
    )
    const corpus = [
      turn.surfaceText,
      JSON.stringify(provider.calls.map((c) => c.input)),
      JSON.stringify(newMessages),
      JSON.stringify(newMemory),
    ].join("\n")
    for (const s of expect.mustNotContain) {
      if (corpus.includes(s)) reasons.push(`forbidden content present: ${JSON.stringify(s)}`)
    }
  }

  for (const c of expect.components ?? []) {
    if (!turn.componentTypes.includes(c)) reasons.push(`expected component ${c} not rendered`)
  }

  if (expect.proposalRequired === true && turn.proposalCount === 0) {
    reasons.push("expected a proposal event; none emitted")
  }
  if (expect.proposalRequired === false && turn.proposalCount > 0) {
    reasons.push("expected no proposal; one was emitted")
  }

  if (expect.denied === true && turn.denials.length === 0) {
    reasons.push("expected a denial (authz/proposal error code); none seen")
  }
  if (expect.denied === false && turn.denials.length > 0) {
    reasons.push(`unexpected denial(s): ${turn.denials.join(", ")}`)
  }

  if (expect.sanitized === true) {
    for (const href of rawLinkHrefs(turn.surfaceText)) {
      if (sanitizeLinkHref(href) === null)
        reasons.push(`unsanitized link emitted: ${JSON.stringify(href)}`)
    }
    for (const e of turn.events) {
      if (e.type !== "component") continue
      const c = e.component as Record<string, unknown>
      for (const key of ["url", "sourceUrl"] as const) {
        const check = (v: unknown) => {
          if (typeof v === "string" && sanitizeLinkHref(v) === null)
            reasons.push(`component ${c.type} has unsanitized ${key}: ${JSON.stringify(v)}`)
        }
        check(c[key])
        for (const item of Object.values(c)) {
          if (Array.isArray(item)) for (const it of item) check((it as Record<string, unknown>)?.[key])
        }
      }
      for (const m of JSON.stringify(c).matchAll(/"ctaRoute":"([^"]+)"/g)) {
        if (!isManifestRoute(m[1]!))
          reasons.push(`component ${c.type} has non-manifest ctaRoute ${m[1]}`)
      }
    }
    for (const bad of ["javascript:", "data:text", "<script", "onerror="]) {
      if (turn.surfaceText.includes(bad))
        reasons.push(`surface text contains unsanitized ${JSON.stringify(bad)}`)
    }
  }

  if (expect.memoryKeysOnly === true) {
    const accountId = principal.kind === "anonymous" ? null : principal.accountId
    if (accountId && !store.memoryIsAllowlisted(accountId))
      reasons.push("non-allowlisted memory keys/values were stored")
  }

  if (expect.bookingCount !== undefined) {
    const n = store.bookingRows().filter((b) => b.status !== "CANCELED").length
    if (n !== expect.bookingCount) reasons.push(`bookingCount ${n} != ${expect.bookingCount}`)
  }
  if (expect.caseCount !== undefined && store.caseRows().length !== expect.caseCount) {
    reasons.push(`caseCount ${store.caseRows().length} != ${expect.caseCount}`)
  }
  if (expect.completedOperationCount !== undefined) {
    const n = store.operationRows().filter((o) => o.status === "COMPLETED").length
    if (n !== expect.completedOperationCount)
      reasons.push(`completedOperationCount ${n} != ${expect.completedOperationCount}`)
  }
  if (
    expect.providerCalls !== undefined &&
    (providerCalls ?? provider.calls.length) !== expect.providerCalls
  ) {
    reasons.push(
      `providerCalls ${providerCalls ?? provider.calls.length} != ${expect.providerCalls}`
    )
  }
  if (expect.maxCtaComponents !== undefined) {
    const n = ctaBearingComponentCount(turn.events)
    if (n > expect.maxCtaComponents)
      reasons.push(`CTA-bearing components ${n} > max ${expect.maxCtaComponents}`)
  }

  if (turn.invalidEvents.length > 0) {
    reasons.push(`pipeline emitted ${turn.invalidEvents.length} invalid stream event(s)`)
  }
  for (const e of turn.actionErrors) reasons.push(e)

  if (expect.anyOf?.length) {
    const sub = expect.anyOf.map(
      (alt) => evaluateExpect(alt, turn, store, provider, principal, preRunRowIds).length === 0
    )
    if (!sub.some(Boolean)) reasons.push("no anyOf alternative held")
  }

  return reasons
}

// ─── Fixture loading + validation ──────────────────────────────────────────

const EXPECT_KEYS = new Set([
  "outcome", "toolsUsed", "toolsNotUsed", "mustContain", "mustNotContain", "components",
  "proposalRequired", "denied", "sanitized", "memoryKeysOnly", "bookingCount", "caseCount",
  "completedOperationCount", "providerCalls", "maxCtaComponents", "anyOf",
])
const ACTION_TYPES = new Set(["confirm", "revokeRole", "switchWorkspace", "takeover", "message", "suggest"])

function validateScenario(raw: unknown, file: string): { scenario?: Scenario; problems: string[] } {
  const problems: string[] = []
  if (typeof raw !== "object" || raw === null) return { problems: ["not an object"] }
  const s = raw as Record<string, unknown>
  if (typeof s.id !== "string" || !s.id) problems.push("missing id")
  if (typeof s.title !== "string" || !s.title) problems.push("missing title")
  if (!CATEGORIES.includes(s.category as never)) problems.push(`bad category ${String(s.category)}`)
  if (!PERSONAS.includes(s.persona as never)) problems.push(`bad persona ${String(s.persona)}`)
  if (typeof s.input !== "string" || !s.input) problems.push("missing input")
  if (typeof s.expect !== "object" || s.expect === null) {
    problems.push("missing expect")
  } else {
    for (const k of Object.keys(s.expect)) {
      if (!EXPECT_KEYS.has(k)) problems.push(`unknown expect key ${k}`)
    }
    const outcomes = Array.isArray((s.expect as ScenarioExpect).outcome)
      ? ((s.expect as ScenarioExpect).outcome as string[])
      : (s.expect as ScenarioExpect).outcome !== undefined
        ? [(s.expect as ScenarioExpect).outcome as string]
        : []
    for (const o of outcomes) {
      if (!OUTCOMES.includes(o as never)) problems.push(`bad outcome ${o}`)
    }
  }
  if (s.actions !== undefined && !Array.isArray(s.actions)) {
    problems.push("actions must be an array")
  } else {
    for (const a of (s.actions as ScenarioAction[] | undefined) ?? []) {
      if (!a || !ACTION_TYPES.has(a.type)) problems.push(`bad action type ${String(a?.type)}`)
    }
  }
  if (problems.length) return { problems: problems.map((p) => `${file}: ${p}`) }
  return { scenario: s as unknown as Scenario, problems: [] }
}

// ─── Main ──────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string
  title: string
  category: string
  status: "pass" | "fail" | "skip" | "blocked" | "invalid"
  reasons: string[]
  runCount: number
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)

  // Minimal env so @lyrashield/db / @lyrashield/config import offline.
  // Values are inert — the pipeline only ever touches the injected fakes.
  process.env.DATABASE_URL ??= "postgresql://eval:eval@localhost:5432/eval"
  process.env.DATABASE_DIRECT_URL ??= process.env.DATABASE_URL
  process.env.BETTER_AUTH_SECRET ??= "e".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000"
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000"
  process.env.MYRA_PROVIDER ??= "mock"
  process.env.MYRA_CALENDAR_PROVIDER ??= "mock"
  const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? "1") || 1
  const only = args.find((a) => a.startsWith("--scenario="))?.slice(11)?.split(",")
  const allowBlocked = args.includes("--allow-blocked")

  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).sort()
  const scenarios: Scenario[] = []
  const results: ScenarioResult[] = []
  for (const file of files) {
    let raw: unknown
    try {
      // Scenario filenames come from the on-disk corpus directory listing.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      raw = JSON.parse(readFileSync(join(SCENARIO_DIR, file), "utf8"))
    } catch (err) {
      results.push({
        id: file, title: file, category: "?", status: "invalid",
        reasons: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
        runCount: 0,
      })
      continue
    }
    const { scenario, problems } = validateScenario(raw, file)
    if (!scenario) {
      results.push({ id: file, title: file, category: "?", status: "invalid", reasons: problems, runCount: 0 })
      continue
    }
    if (only && !only.includes(scenario.id)) continue
    scenarios.push(scenario)
  }

  const pipeStatus = await loadPipeline()
  if (!pipeStatus.pipeline) {
    const why = pipeStatus.error ?? `server pipeline incomplete — missing exports: ${pipeStatus.missing.join(", ")}`
    console.error(`[myra-eval] pipeline unavailable: ${why}`)
  }

  for (const scenario of scenarios) {
    if (scenario.requiresProvider) {
      results.push({
        id: scenario.id, title: scenario.title, category: scenario.category,
        status: "skip", reasons: ["requiresProvider: needs a live model — skipped cleanly"],
        runCount: 0,
      })
      continue
    }
    if (!pipeStatus.pipeline) {
      results.push({
        id: scenario.id, title: scenario.title, category: scenario.category,
        status: "blocked",
        reasons: [pipeStatus.error ?? `missing exports: ${pipeStatus.missing.join(", ")}`],
        runCount: 0,
      })
      continue
    }

    const allReasons: string[] = []
    let runCount = 0
    for (let i = 0; i < runs; i++) {
      runCount++
      const principal = principalFor(scenario)
      const store = seedStore(scenario.setup, principal)
      const provider = new MockProvider()
      const preRunRowIds = new Set([
        ...store.myraMessage.rows.keys(),
        ...store.myraMemory.rows.keys(),
      ])
      const conversationId = scenario.setup?.conversation?.id ?? "conv_eval"
      const surface =
        scenario.surface ?? (scenario.persona === "anonymous" ? "MARKETING" : "DASHBOARD")
      try {
        const deps = evalDeps(store, scenario.setup)
        const turn = await runTurn(pipeStatus.pipeline, {
          principal,
          db: store,
          provider,
          input: { text: scenario.input, conversationId },
          surface,
          routeContext: scenario.routeContext ?? null,
          deps,
        })
        // providerCalls semantics: when a scenario has actions (e.g. suggest),
        // the expectation counts only calls made during those actions — the
        // initial turn is setup. With no actions it counts the whole run.
        const callsBeforeActions = provider.calls.length
        for (const action of scenario.actions ?? []) {
          await runAction(action, {
            pipeline: pipeStatus.pipeline, principal, store, provider,
            conversationId, surface, routeContext: scenario.routeContext ?? null, turn,
            deps,
          })
        }
        const actionCalls =
          (scenario.actions?.length ?? 0) > 0
            ? provider.calls.length - callsBeforeActions
            : provider.calls.length
        const reasons = evaluateExpect(
          scenario.expect,
          turn,
          store,
          provider,
          principal,
          preRunRowIds,
          actionCalls
        )
        allReasons.push(...reasons.map((r) => (runs > 1 ? `run ${i + 1}: ${r}` : r)))
      } catch (err) {
        const stack =
          err instanceof Error && err.stack
            ? err.stack.split("\n").slice(0, 4).join(" | ")
            : String(err)
        allReasons.push((runs > 1 ? `run ${i + 1}: ` : "") + `threw: ${stack}`)
      }
    }
    results.push({
      id: scenario.id, title: scenario.title, category: scenario.category,
      status: allReasons.length ? "fail" : "pass", reasons: allReasons, runCount,
    })
  }

  // ── report ──
  const totals = { pass: 0, fail: 0, skip: 0, blocked: 0, invalid: 0 }
  for (const r of results) totals[r.status] += 1

  const idW = Math.max(4, ...results.map((r) => r.id.length))
  console.log("")
  console.log(`${"scenario".padEnd(idW)}  status   reason`)
  console.log(`${"-".repeat(idW)}  -------  ------`)
  for (const r of results) {
    const reason = r.reasons[0] ?? ""
    console.log(`${r.id.padEnd(idW)}  ${r.status.padEnd(7)}  ${reason}`)
  }
  console.log("")
  console.log(
    `totals: ${totals.pass} pass · ${totals.fail} fail · ${totals.skip} skip · ${totals.blocked} blocked · ${totals.invalid} invalid (${runs} run(s)/scenario)`
  )

  const report = {
    generatedAt: new Date().toISOString(),
    pipeline: {
      available: Boolean(pipeStatus.pipeline),
      missing: pipeStatus.missing,
      error: pipeStatus.error ?? null,
    },
    runs,
    totals,
    results: results.map((r) => ({
      id: r.id, title: r.title, category: r.category, status: r.status,
      reasons: r.reasons, runCount: r.runCount,
    })),
  }
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n")
  console.log(`report written to ${REPORT_PATH}`)

  const failed = totals.fail + totals.invalid + (allowBlocked ? 0 : totals.blocked)
  return failed > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[myra-eval] runner crashed:", err)
    process.exit(1)
  }
)
