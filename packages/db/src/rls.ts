import { prisma } from "./client"
import { runWithDatabaseRLSContext } from "./scoping"

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
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`
    return runWithDatabaseRLSContext(workspaceId, () => fn(tx))
  })
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
    await tx.$executeRaw`RESET app.current_workspace_id`
    return fn(tx)
  })
}
