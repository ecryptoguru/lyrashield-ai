import { prisma } from "./client"
import { Prisma } from "./generated/prisma"
import { runWithDatabaseRLSContext } from "./scoping"

interface WorkspaceTransactionOptions {
  maxWait?: number
  timeout?: number
  isolationLevel?: Prisma.TransactionIsolationLevel
  /**
   * Bind `app.current_account_id` alongside the workspace context. Required
   * when the transaction reads or writes the account-owned ledger
   * (BillingAccount / UsageRecord / MinutePack) by accountId — e.g. scan
   * metering draws the sponsoring account's balance across workspaces.
   */
  accountId?: string | null
}

/**
 * Run a callback inside a Prisma transaction with `SET LOCAL
 * app.current_workspace_id` so that Postgres Row Level Security (RLS)
 * policies can enforce workspace isolation at the database level.
 *
 * Strict workspace policies deny access when this context is absent. Ordinary
 * extended-client queries set the same transaction-local context automatically;
 * use this helper for multi-query atomic operations.
 *
 * This is the connection-safe way to activate RLS with Prisma's pooled
 * adapter: `SET LOCAL` scopes the setting to the current transaction,
 * avoiding the session-level leak risk of plain `SET`.
 *
 * Usage:
 * ```ts
 * const projects = await withWorkspaceRLS(workspaceId, (tx) =>
 *   tx.project.findMany({ where: { workspaceId } })
 * )
 * ```
 *
 * The `tx` client passed to the callback is a transactional Prisma client
 * that has the RLS context active. All workspace-scoped queries inside the
 * callback are eligible for both the application-level extension
 * (AsyncLocalStorage) and database-level RLS policies.
 */
export async function withWorkspaceRLS<T>(
  workspaceId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
  options?: WorkspaceTransactionOptions
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${options?.accountId ?? ""}, true)`
    return runWithDatabaseRLSContext(workspaceId, () => fn(tx), options?.accountId ?? null)
  }, options)
}

/**
 * Run a callback inside a transaction bound to an account context only.
 * Account-owned billing rows (BillingAccount / UsageRecord / MinutePack) are
 * visible via the account RLS policy; every other workspace-scoped table
 * fails closed because no workspace context is set.
 */
export async function withAccountRLS<T>(
  accountId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
  options?: Omit<WorkspaceTransactionOptions, "accountId">
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
    return runWithDatabaseRLSContext(null, () => fn(tx), accountId)
  }, options)
}

/**
 * Run a callback inside a transaction bound to a Myra anonymous public
 * session. Dual-owner support tables (myra_conversations, support_cases,
 * demo_bookings, myra_operations, myra_public_sessions and their children)
 * are visible only where `publicSessionId` matches; the account-owner and
 * unbound trusted-path policies do not apply. `app.current_workspace_id` is
 * explicitly cleared so a workspace context can never stand in for public
 * session ownership.
 *
 * `SET LOCAL` keeps the binding transaction-scoped — the same
 * connection-safe pattern as withWorkspaceRLS/withAccountRLS.
 */
export async function withMyraPublicRLS<T>(
  publicSessionId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
  options?: Omit<WorkspaceTransactionOptions, "accountId">
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
    await tx.$executeRaw`SELECT set_config('app.myra_public_session_id', ${publicSessionId}, true)`
    return runWithDatabaseRLSContext(null, () => fn(tx), null)
  }, options)
}

/**
 * Run a callback inside a transaction bound to a Myra operator/trusted
 * context. The dual-owner tables' RESTRICTIVE boundary admits this path —
 * and only this path — when neither owner context is set: the boundary
 * expression requires one of the three settings to be non-empty, so an
 * operator-bound transaction reads across owners while a context-free read
 * fails closed.
 *
 * Callers: the platform-operator routes (operatorId = the verified admin's
 * user id, authorized by requirePlatformAdmin*) and named internal paths
 * trusted across owners — retention sweeps, manage-token booking reads,
 * account deletion — each binding its own sentinel id. Workspace, account
 * and public-session settings are explicitly cleared so a stale or claimed
 * owner context can never merge with the operator one; the bind is
 * transaction-local and the ALS account context is cleared for the
 * callback's duration.
 */
export async function withMyraOperatorRLS<T>(
  operatorId: string,
  fn: (tx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await bindMyraOperatorRLSContext(tx, operatorId)
    return runWithDatabaseRLSContext(null, () => fn(tx), null)
  })
}

/** Transactional Prisma client as passed to `withWorkspaceRLS`/`withAccountRLS` callbacks. */
export type ScopedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

type BoundTx = ScopedTransaction

/**
 * Bind `app.current_account_id` inside an ALREADY-OPEN transaction.
 *
 * For callers that learn the owning account after the transaction begins
 * (e.g. the fix-PR loop-closure resolves the retest sponsor mid-lock), this
 * upgrades the tx so account-scoped reads/writes resolve through the account
 * RLS policy on the same connection. `SET LOCAL` keeps it transaction-scoped.
 * The ALS context is left untouched: inside a bound tx the extension already
 * skips re-wrapping, and `applyQueryGuards` only needs the workspace context.
 */
export async function bindAccountRLSContext(tx: BoundTx, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
}

/**
 * Bind `app.myra_public_session_id` inside an ALREADY-OPEN transaction.
 *
 * For callers that resolve the anonymous public session after the
 * transaction begins, this upgrades the tx so Myra public-owner policies
 * resolve on the same connection. `SET LOCAL` keeps it transaction-scoped.
 */
export async function bindMyraPublicRLSContext(
  tx: BoundTx,
  publicSessionId: string
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.myra_public_session_id', ${publicSessionId}, true)`
}

/**
 * Bind the Myra trusted/operator setting inside an already-open transaction.
 * Critical platform-admin mutations use this with the transaction that also
 * consumes their elevation nonce and appends the mandatory audit record.
 */
export async function bindMyraOperatorRLSContext(tx: BoundTx, operatorId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
  await tx.$executeRaw`SELECT set_config('app.current_account_id', '', true)`
  await tx.$executeRaw`SELECT set_config('app.myra_public_session_id', '', true)`
  await tx.$executeRaw`SELECT set_config('app.myra_operator_id', ${operatorId}, true)`
}

/**
 * Run a callback inside a Prisma transaction with RLS context cleared. Strict
 * workspace tables remain inaccessible; only deliberately unscoped tables may
 * be queried. The reset prevents stale pooled-connection context.
 */
export async function withoutWorkspaceRLS<T>(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', '', true)`
    await tx.$executeRaw`SELECT set_config('app.current_account_id', '', true)`
    await tx.$executeRaw`SELECT set_config('app.myra_public_session_id', '', true)`
    return fn(tx)
  })
}
