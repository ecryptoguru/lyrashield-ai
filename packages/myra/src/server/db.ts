/**
 * Owner-scoped DB access for Myra tables. Authenticated principals bind
 * `app.current_account_id`; anonymous principals bind the public-session
 * context via `withMyraPublicRLS`. Operator/system paths run unbound —
 * callers apply service-layer authorization before reaching them.
 */
import { prisma, withAccountRLS, withMyraPublicRLS } from "@lyrashield/db"
import type { ScopedTransaction } from "@lyrashield/db"
import type { MyraPrincipal } from "../contracts"

export type MyraDb = typeof prisma | ScopedTransaction

/** Owner `where` fragment for Myra-owned rows. */
export function ownerWhere(
  principal: MyraPrincipal
): { accountId: string } | { publicSessionId: string } | Record<string, never> {
  if (principal.kind === "user") return { accountId: principal.accountId }
  if (principal.kind === "anonymous") return { publicSessionId: principal.publicSessionId }
  return {}
}

/**
 * Run `fn` inside the principal's RLS binding. When `db` is already a
 * transaction (caller bound the scope), the callback reuses it directly.
 * Operators run unbound: the service layer has already authorized them.
 */
export async function withOwnerScope<T>(
  principal: MyraPrincipal,
  fn: (tx: ScopedTransaction) => Promise<T>,
  db?: MyraDb
): Promise<T> {
  if (db && db !== prisma) return fn(db as ScopedTransaction)
  if (principal.kind === "user") return withAccountRLS(principal.accountId, fn)
  if (principal.kind === "anonymous") {
    return withMyraPublicRLS(principal.publicSessionId, fn)
  }
  return fn(prisma as unknown as ScopedTransaction)
}
