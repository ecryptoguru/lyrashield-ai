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
 * NOTE: as of this change nothing calls this in request handlers yet — routes
 * still scope explicitly with `where: { workspaceId }`. Activating auto-scoping
 * (calling this from the auth guard) + Postgres RLS is a deliberate follow-up
 * that needs integration tests against a live database.
 */
export function setWorkspaceContext(workspaceId: string | null): void {
  workspaceStore.enterWith({ workspaceId })
}

export function getWorkspaceContext(): string | null {
  return workspaceStore.getStore()?.workspaceId ?? null
}

/**
 * Pure guard: given the current workspace context, returns the (possibly
 * augmented) query args. Injects `deletedAt: null` for soft-delete models and
 * `workspaceId` for workspace-scoped models on read operations only, never
 * overriding a `workspaceId` the caller already supplied.
 */
export function applyQueryGuards(
  model: string | undefined,
  operation: string,
  args: Record<string, unknown>,
  workspaceId: string | null
): Record<string, unknown> {
  if (!model) return args
  if (!READ_OPS.has(operation)) return args

  const where = (args.where as Record<string, unknown> | undefined) ?? {}
  const additions: Record<string, unknown> = {}

  if (SOFT_DELETE_MODELS.has(model)) {
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
