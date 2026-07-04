import { prisma } from "./client"

/**
 * Run a callback inside a Prisma transaction with `SET LOCAL
 * app.current_workspace_id` so that Postgres Row Level Security (RLS)
 * policies enforce workspace isolation at the database level.
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
 * callback are enforced by both the application-level extension (AsyncLocalStorage)
 * and the database-level RLS policies.
 */
export async function withWorkspaceRLS<T>(
  workspaceId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL app.current_workspace_id = ${workspaceId}`
    return fn(tx)
  })
}

/**
 * Run a callback inside a Prisma transaction with RLS context cleared.
 * Useful for cross-workspace admin operations (e.g. workspace switcher).
 * The `RESET` ensures no stale context leaks from a pooled connection.
 */
export async function withoutWorkspaceRLS<T>(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`RESET app.current_workspace_id`
    return fn(tx)
  })
}
