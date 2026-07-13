import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Workspace-scoping + soft-delete policy for the Prisma client extension.
 *
 * This module is intentionally free of any Prisma-client import so the policy
 * (model sets + guard logic + request context) can be unit-tested without the
 * generated client, and reused by the worker.
 *
 * Request-scoped workspace context uses AsyncLocalStorage — NOT a module-level
 * variable. A shared module variable leaks across concurrently-served requests
 * in a single Node process (a cross-tenant read), which is unacceptable for a
 * multi-tenant security product.
 */

// Models that carry a `deletedAt` column. ONLY these may have `deletedAt: null`
// injected on reads / be redirected from delete → soft-delete. Injecting
// `deletedAt` on a model without the column throws a Prisma validation error,
// so this set must match the schema exactly.
export const SOFT_DELETE_MODELS = new Set<string>([
  "Workspace",
  "Project",
  "Target",
  "Policy",
  "Scan",
  "ScanEvent",
  "ApiKey",
  "Finding",
  "FixProposal",
  "PullRequest",
  "Ticket",
  "Integration",
  "UsageRecord",
  "Report",
  "Notification",
  "Schedule",
  "BillingAccount",
  "Invitation",
  "WebhookEvent",
])

// Models that carry a `workspaceId` column AND are safe to auto-scope by the
// current workspace context. Excludes:
//  - WorkspaceMember: legitimately queried cross-workspace (e.g. listing every
//    workspace a user belongs to for the switcher) — auto-scoping would break it.
//  - OnboardingState: a per-user record keyed by userId, not tenant data.
//  - ReferralCode, ReferralAttribution, ScorecardShare, and ScorecardEvent:
//    no workspaceId column; score-service.ts owns their explicit isolation invariants.
// Injecting `workspaceId` on a model without the column throws, so — as with
// soft-delete — this set must match the schema exactly.
export const WORKSPACE_SCOPED_MODELS = new Set<string>([
  "Project",
  "Target",
  "CredentialSet",
  "Policy",
  "Scan",
  "ApiKey",
  "Finding",
  "Integration",
  "UsageRecord",
  "AuditLog",
  "Report",
  "Notification",
  "Schedule",
  "BillingAccount",
  "Invitation",
  "WebhookEvent",
  "Retest",
  "AgentApproval",
  "ScoreSnapshot",
])

export const READ_OPS = new Set<string>([
  "findMany",
  "findUnique",
  "findFirst",
  "findRaw",
  "count",
  "aggregate",
  "groupBy",
])

// Bulk-write ops that accept an arbitrary `where`. A forgotten `workspaceId`
// here is catastrophic (a cross-tenant mass update/delete), so — when a
// workspace context is bound — we inject `workspaceId` as a defense-in-depth
// backstop. Single-row `update`/`delete` are intentionally NOT in this set:
// they target one row by unique id and routes already scope them via a prior
// workspace-scoped read; leaving them out avoids surprising unique-where edge
// cases. (S7)
export const WRITE_SCOPE_OPS = new Set<string>(["updateMany", "deleteMany"])

const workspaceStore = new AsyncLocalStorage<{ workspaceId: string | null }>()

/**
 * Run `fn` with a workspace context bound for its entire async execution.
 * This is the safe primitive (wrapping) — prefer it in workers/jobs.
 */
export function runWithWorkspaceContext<T>(workspaceId: string | null, fn: () => T): T {
  return workspaceStore.run({ workspaceId }, fn)
}

/**
 * Bind a workspace context for the remainder of the current async execution
 * without wrapping (e.g. immediately after an auth guard resolves in a request
 * handler). Each request runs in its own async context, so this does not leak
 * across requests the way a module-level variable would.
 *
 * Auto-scoping is ACTIVE: `requireWorkspaceAccess` calls this after resolving
 * the workspace. The Prisma client extension auto-injects `workspaceId` on all
 * workspace-scoped models. RLS policies remain permissive when their context is
 * unset, and no request/job path currently calls `withWorkspaceRLS()`. Active
 * isolation is explicit query filters plus this AsyncLocalStorage guard; new
 * services should use `withWorkspaceRLS()` for an incremental strict cutover.
 */
export function setWorkspaceContext(workspaceId: string | null): void {
  workspaceStore.enterWith({ workspaceId })
}

export function getWorkspaceContext(): string | null {
  return workspaceStore.getStore()?.workspaceId ?? null
}

/**
 * Pure guard: given the current workspace context, returns the (possibly
 * augmented) query args.
 *  - On READ ops: injects `deletedAt: null` (soft-delete models) and
 *    `workspaceId` (workspace-scoped models).
 *  - On BULK-WRITE ops (updateMany/deleteMany): injects `workspaceId` only —
 *    a defense-in-depth backstop against a forgotten tenant filter on a mass
 *    mutation. (S7)
 * Never overrides a `workspaceId` the caller already supplied.
 */
export function applyQueryGuards(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>,
  workspaceId: string | null
): Record<string, unknown> {
  if (!model) return args
  const isRead = READ_OPS.has(operation)
  const isBulkWrite = WRITE_SCOPE_OPS.has(operation)
  if (!isRead && !isBulkWrite) return args

  const where = (args.where as Record<string, unknown> | undefined) ?? {}
  const additions: Record<string, unknown> = {}

  if (isRead && SOFT_DELETE_MODELS.has(model)) {
    additions.deletedAt = null
  }

  if (WORKSPACE_SCOPED_MODELS.has(model) && workspaceId && !("workspaceId" in where)) {
    additions.workspaceId = workspaceId
  }

  if (Object.keys(additions).length === 0) return args

  return {
    ...args,
    where: { ...where, ...additions },
  }
}
