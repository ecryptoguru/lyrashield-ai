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
    return fn(tx)
  })
}
