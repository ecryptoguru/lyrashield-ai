/**
 * Guided-flow state machine over GUIDED_FLOWS step graphs. Steps with a
 * `check` re-run their read-only tool and advance only on observed state —
 * never on the user's word.
 */
import { z } from "zod"
import { getFlow } from "../../flows"
import type { FlowStep } from "../../flows"
import type { MyraComponent } from "../../contracts"
import { err } from "../errors"
import { withOwnerScope } from "../db"
import { runGetConnectionHealth, runGetScanStatus } from "./diagnostics"
import { runGetMyContext } from "./context"
import type { MyraToolContext, MyraToolResult } from "./types"

export const startGuidedFlowInput = z.object({ flowId: z.string().max(60) })
export const advanceGuidedFlowInput = z.object({ flowSessionId: z.string().max(80) })
export const verifyResolutionInput = z.object({ flowSessionId: z.string().max(80).optional() })

interface FlowSessionRow {
  id: string
  conversationId: string
  flowId: string
  stepIndex: number
  status: string
}

async function loadOwnedFlowSession(
  ctx: MyraToolContext,
  flowSessionId: string
): Promise<FlowSessionRow> {
  return withOwnerScope(
    ctx.principal,
    async (tx) => {
      const session = await tx.myraFlowSession.findUnique({ where: { id: flowSessionId } })
      if (!session) throw err("NOT_FOUND", "Flow session not found.")
      const conversation = await tx.myraConversation.findUnique({
        where: { id: session.conversationId },
        select: { accountId: true, publicSessionId: true, workspaceId: true },
      })
      const owns =
        ctx.principal.kind === "user"
          ? conversation?.accountId === ctx.principal.accountId
          : ctx.principal.kind === "anonymous" &&
            conversation?.publicSessionId === ctx.principal.publicSessionId
      if (!owns) throw err("FORBIDDEN", "This flow belongs to a different session.")
      // A flow never survives a workspace switch — including losing workspace
      // access entirely (ctx.workspaceId null) — without re-validation.
      if (conversation?.workspaceId && conversation.workspaceId !== ctx.workspaceId) {
        await tx.myraFlowSession.update({
          where: { id: session.id },
          data: { status: "ABANDONED" },
        })
        throw err("FORBIDDEN", "Workspace changed — the flow was reset.")
      }
      return session
    },
    ctx.db
  )
}

function flowComponent(
  flowId: string,
  stepIndex: number,
  status: string,
  blockedStepId?: string
): MyraComponent {
  const flow = getFlow(flowId)
  return {
    type: "guided_flow",
    flowId,
    flowTitle: flow?.title ?? flowId,
    stepIndex,
    status: status as "ACTIVE" | "COMPLETED" | "ESCALATED" | "ABANDONED",
    steps: (flow?.steps ?? []).map((s, i) => ({
      id: s.id,
      title: s.title,
      status:
        i < stepIndex
          ? "done"
          : i === stepIndex
            ? s.id === blockedStepId
              ? "blocked"
              : "active"
            : "pending",
    })),
  }
}

/** Evaluate a step's `expect` against a tool result. */
function checkExpectation(expect: string, data: Record<string, unknown>): boolean {
  const trimmed = expect.trim()
  if (trimmed === "status known") {
    return Boolean((data.scan as { status?: string } | null)?.status)
  }
  if (trimmed === "trial state returned") return typeof data.plan === "string"
  if (trimmed === "scan_can_start") return data.scanCanStart === true
  const m = /^(\w+)\s*(==|!=|>=|<=|>|<)\s*(\S+)$/.exec(trimmed)
  if (!m) return false
  const left = data[m[1]!]
  const rightRaw = m[3]!
  const right =
    rightRaw === "true"
      ? true
      : rightRaw === "false"
        ? false
        : Number.isNaN(Number(rightRaw))
          ? rightRaw
          : Number(rightRaw)
  switch (m[2]) {
    case "==":
      return left === right
    case "!=":
      return left !== right
    case ">":
      return Number(left) > Number(right)
    case "<":
      return Number(left) < Number(right)
    case ">=":
      return Number(left) >= Number(right)
    case "<=":
      return Number(left) <= Number(right)
    default:
      return false
  }
}

async function runCheckTool(
  ctx: MyraToolContext,
  step: FlowStep
): Promise<Record<string, unknown> | null> {
  if (!step.check) return null
  try {
    if (step.check.tool === "get_my_context") return (await runGetMyContext(ctx, {})).data
    if (step.check.tool === "get_connection_health")
      return (await runGetConnectionHealth(ctx, {})).data
    if (step.check.tool === "get_scan_status") return (await runGetScanStatus(ctx, {})).data
    if (step.check.tool === "verify_resolution") return (await runVerifyResolution(ctx, {})).data
  } catch {
    return null
  }
  return null
}

export async function runStartGuidedFlow(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { flowId } = startGuidedFlowInput.parse(input)
  if (!ctx.conversationId) throw err("VALIDATION_ERROR", "No conversation for this flow.")
  const flow = getFlow(flowId)
  const surface = ctx.surface === "DASHBOARD" ? "app" : "marketing"
  if (!flow || !flow.surfaces.includes(surface)) throw err("NOT_FOUND", "Unknown flow.")
  // Resume an ACTIVE session for this flow — guided flows are resumable.
  const existing = await withOwnerScope(
    ctx.principal,
    async (tx) => {
      const session = await tx.myraFlowSession.findFirst({
        where: { conversationId: ctx.conversationId!, flowId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      })
      if (!session) return null
      // Resume never survives a workspace switch — re-validate or fail closed.
      const conversation = await tx.myraConversation.findUnique({
        where: { id: session.conversationId },
        select: { workspaceId: true },
      })
      if (conversation?.workspaceId && conversation.workspaceId !== ctx.workspaceId) {
        await tx.myraFlowSession.update({
          where: { id: session.id },
          data: { status: "ABANDONED" },
        })
        throw err("FORBIDDEN", "Workspace changed — the flow was reset.")
      }
      return session
    },
    ctx.db
  )
  const session =
    existing ??
    (await withOwnerScope(
      ctx.principal,
      (tx) =>
        tx.myraFlowSession.create({
          data: { conversationId: ctx.conversationId!, flowId, stepIndex: 0, status: "ACTIVE" },
        }),
      ctx.db
    ))
  return {
    data: {
      flowSessionId: session.id,
      flowId,
      stepIndex: session.stepIndex,
      status: "ACTIVE",
      resumed: existing != null,
      instruction: flow.steps[session.stepIndex]?.instruction ?? "",
    },
    components: [flowComponent(flowId, session.stepIndex, "ACTIVE")],
  }
}

export async function runAdvanceGuidedFlow(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  const { flowSessionId } = advanceGuidedFlowInput.parse(input)
  const session = await loadOwnedFlowSession(ctx, flowSessionId)
  if (session.status !== "ACTIVE") {
    return {
      data: { flowSessionId, status: session.status, stepIndex: session.stepIndex },
      components: [flowComponent(session.flowId, session.stepIndex, session.status)],
    }
  }
  const flow = getFlow(session.flowId)
  if (!flow) throw err("NOT_FOUND", "Unknown flow.")
  const step = flow.steps[session.stepIndex]
  if (!step) throw err("PROPOSAL_STATE_INVALID", "Flow is out of range.")

  // Checked steps re-run their tool; advance only on the expected condition.
  if (step.check) {
    const data = await runCheckTool(ctx, step)
    const passed = data !== null && checkExpectation(step.check.expect, data)
    if (!passed) {
      return {
        data: {
          flowSessionId,
          status: "ACTIVE",
          stepIndex: session.stepIndex,
          blocked: true,
          instruction: step.instruction,
        },
        components: [flowComponent(flow.id, session.stepIndex, "ACTIVE", step.id)],
      }
    }
  }

  const nextIndex = session.stepIndex + 1
  const done = nextIndex >= flow.steps.length
  const status = done ? "COMPLETED" : "ACTIVE"
  await withOwnerScope(
    ctx.principal,
    (tx) =>
      tx.myraFlowSession.update({
        where: { id: session.id },
        data: { stepIndex: done ? session.stepIndex : nextIndex, status },
      }),
    ctx.db
  )
  return {
    data: {
      flowSessionId,
      status,
      stepIndex: done ? session.stepIndex : nextIndex,
      instruction: done ? null : flow.steps[nextIndex]?.instruction,
    },
    components: [flowComponent(flow.id, done ? session.stepIndex : nextIndex, status)],
  }
}

export async function runVerifyResolution(
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  verifyResolutionInput.parse(input)
  const [myContext, health] = await Promise.all([
    runGetMyContext(ctx, {}).catch(() => null),
    runGetConnectionHealth(ctx, {}).catch(() => null),
  ])
  const targetCount = (myContext?.data.targetCount as number | null) ?? 0
  const canScan = myContext?.data.canScan === true
  const unhealthy = (health?.data.unhealthy as number | undefined) ?? 0
  const scanCanStart = targetCount > 0 && canScan && unhealthy === 0
  return {
    data: {
      checkedAt: new Date().toISOString(),
      scanCanStart,
      targetCount,
      canScan,
      unhealthy,
    },
  }
}
