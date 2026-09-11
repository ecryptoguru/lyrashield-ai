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

// Models that are lifecycle-soft-deletable. ONLY these may have `deletedAt: null`
// injected on reads / be redirected from delete → soft-delete. `WebhookEvent`
// intentionally remains visible: the provider-event unique key is the durable
// replay/deduplication ledger. Injecting `deletedAt` on a model without the
// column throws a Prisma validation error, so this set must match the schema.
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
  "MinutePack",
  "Invitation",
])

// Models that carry a `workspaceId` column AND are safe to auto-scope by the
// current workspace context. Excludes:
//  - WorkspaceMember: legitimately queried cross-workspace (e.g. listing every
//    workspace a user belongs to for the switcher) — auto-scoping would break it.
//  - OnboardingState: a per-user record keyed by userId, not tenant data.
//  - ReferralCode, ReferralAttribution, ScorecardShare, and ScorecardEvent:
//    no workspaceId column; score-service.ts owns their explicit isolation invariants.
//  - WebhookEventTrack: delivery tracking for provider webhook processing.
//    Its workspaceId is a nullable, best-effort attribution stamp written
//    during webhook fan-out — the parent WebhookEvent resolves the workspace
//    cross-workspace before any track row exists (billing/license/affiliate
//    webhooks arrive before the workspace is known). Track rows are only ever
//    read by the reconciliation sweep and admin surfaces, never by a
//    workspace-scoped request, so RLS scoping would be both wrong (rows with
//    NULL workspaceId are the normal case mid-fan-out) and useless (no
//    workspace request path queries it).
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
  "MinutePack",
  "Invitation",
  "WebhookEvent",
  "Retest",
  "AgentApproval",
  "ScoreSnapshot",
  "FindingCandidate",
  "FindingVerification",
  "AiSystemProfile",
  "ThreatModel",
  "ControlEvidence",
  "AiSecurityScoreSnapshot",
  "TargetDomainVerification",
  "LiveAiSafetySettings",
  "LiveAiSafetyPlan",
  "LiveAiSafetyRun",
  "GateVerdict",
  "AgentConnection",
  "AgentOperation",
  "LoopClosure",
])

// Account-owned ledger models: subscriptions and usage belong to the account
// (User.id), not the workspace. `workspaceId` on these models is purchase or
// consumption attribution only. An explicit `accountId` in `where` therefore
// opts the query out of workspaceId auto-injection — the PostgreSQL account
// policy (app.current_account_id) is the real boundary.
export const ACCOUNT_OWNED_MODELS = new Set<string>(["BillingAccount", "UsageRecord", "MinutePack"])

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

type WorkspaceContext = {
  workspaceId: string | null
  /** Bound account (User.id) for account-owned billing reads/writes. */
  accountId: string | null
  databaseRlsBound: boolean
}

// Match the development Prisma singleton's lifetime. Otherwise HMR can leave
// its extension reading an old store while reloaded transaction helpers bind a
// new one, causing a protected write to escape its caller's transaction.
// Only the storage instance is shared; request values remain async-local.
const globalForWorkspace = globalThis as unknown as {
  lyrashieldWorkspaceStore?: AsyncLocalStorage<WorkspaceContext>
}
const workspaceStore =
  globalForWorkspace.lyrashieldWorkspaceStore ?? new AsyncLocalStorage<WorkspaceContext>()
if (process.env.NODE_ENV !== "production") {
  globalForWorkspace.lyrashieldWorkspaceStore = workspaceStore
}

function preserveContextForThenable<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    // PrismaPromise is lazy: its query starts when `then` is consumed, which
    // can otherwise happen after AsyncLocalStorage.run has restored the caller
    // context. Assimilate thenables inside this async resource so the workspace
    // context remains active for the actual database operation.
    return (async () => await value)() as T
  }
  return value
}

/**
 * Run `fn` with a workspace context bound for its entire async execution.
 * This is the safe primitive (wrapping) — prefer it in workers/jobs.
 */
export function runWithWorkspaceContext<T>(workspaceId: string | null, fn: () => T): T {
  return workspaceStore.run({ workspaceId, accountId: null, databaseRlsBound: false }, () =>
    preserveContextForThenable(fn())
  )
}

export function runWithDatabaseRLSContext<T>(
  workspaceId: string | null,
  fn: () => T,
  accountId: string | null = null
): T {
  return workspaceStore.run({ workspaceId, accountId, databaseRlsBound: true }, () =>
    preserveContextForThenable(fn())
  )
}

/**
 * Bind only an account context for `fn` (no workspace). Account-owned billing
 * reads run against the account RLS policy; workspace-scoped models without
 * an account policy fail closed.
 */
export function runWithAccountContext<T>(accountId: string, fn: () => T): T {
  return workspaceStore.run({ workspaceId: null, accountId, databaseRlsBound: false }, () =>
    preserveContextForThenable(fn())
  )
}

/**
 * Bind a workspace context for the remainder of the current async execution
 * without wrapping (e.g. immediately after an auth guard resolves in a request
 * handler). Each request runs in its own async context, so this does not leak
 * across requests the way a module-level variable would.
 *
 * Auto-scoping is ACTIVE: `requireWorkspaceAccess` calls this after resolving
 * the workspace. The Prisma client extension auto-injects `workspaceId` and
 * binds the matching transaction-local PostgreSQL RLS context for every
 * workspace-scoped model operation. Multi-query atomic operations must use
 * `withWorkspaceRLS()` so all statements retain one scoped connection.
 */
export function setWorkspaceContext(workspaceId: string | null): void {
  workspaceStore.enterWith({ workspaceId, accountId: null, databaseRlsBound: false })
}

/**
 * Bind the account context for the remainder of the current async execution.
 * Preserves any workspace context already bound (a request can act in a
 * workspace while reading its own account's billing state).
 */
export function setAccountContext(accountId: string | null): void {
  const current = workspaceStore.getStore()
  workspaceStore.enterWith({
    workspaceId: current?.workspaceId ?? null,
    accountId,
    databaseRlsBound: current?.databaseRlsBound ?? false,
  })
}

export function getWorkspaceContext(): string | null {
  return workspaceStore.getStore()?.workspaceId ?? null
}

export function getAccountContext(): string | null {
  return workspaceStore.getStore()?.accountId ?? null
}

export function isDatabaseRLSContextBound(): boolean {
  return workspaceStore.getStore()?.databaseRlsBound ?? false
}

/**
 * Recover the workspace already present in a server-owned Prisma operation
 * when no request/job context survived to the query's async resource. This is
 * not an authorization decision: PostgreSQL is bound to the same workspaceId
 * that the query already filters or writes.
 */
export function getExplicitWorkspaceId(args: Record<string, unknown>): string | null {
  const where = args.where as Record<string, unknown> | undefined
  if (typeof where?.workspaceId === "string" && where.workspaceId) return where.workspaceId

  const data = args.data as Record<string, unknown> | undefined
  if (typeof data?.workspaceId === "string" && data.workspaceId) return data.workspaceId

  return null
}

/**
 * Recover the accountId present in an account-owned model operation. Like
 * `getExplicitWorkspaceId` this is not an authorization decision: the account
 * RLS policy only permits rows whose accountId equals the bound context, so a
 * self-declared account filter can never widen what the query may see.
 */
export function getExplicitAccountId(args: Record<string, unknown>): string | null {
  const where = args.where as Record<string, unknown> | undefined
  if (typeof where?.accountId === "string" && where.accountId) return where.accountId

  const data = args.data as Record<string, unknown> | undefined
  if (typeof data?.accountId === "string" && data.accountId) return data.accountId

  return null
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

  // An explicit accountId on an account-owned model is an account-scoped
  // query: the account RLS policy bounds it, so do not pin it to the current
  // workspace (the account's ledger spans workspaces).
  const accountScoped = ACCOUNT_OWNED_MODELS.has(model) && "accountId" in where
  if (
    WORKSPACE_SCOPED_MODELS.has(model) &&
    workspaceId &&
    !("workspaceId" in where) &&
    !accountScoped
  ) {
    additions.workspaceId = workspaceId
  }

  if (Object.keys(additions).length === 0) return args

  return {
    ...args,
    where: { ...where, ...additions },
  }
}
