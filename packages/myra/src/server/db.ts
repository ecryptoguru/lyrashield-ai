/**
 * Owner-scoped DB access for Myra tables. Authenticated principals bind
 * `app.current_account_id`; anonymous principals bind the public-session
 * context via `withMyraPublicRLS`; operator and system paths declare
 * themselves through `withMyraOperatorRLS` with a sentinel id — the
 * route-level or credential check stays the authorization, the binding
 * only declares the path to the dual-owner tables' RESTRICTIVE boundary.
 */
import { prisma, withAccountRLS, withMyraOperatorRLS, withMyraPublicRLS } from "@lyrashield/db"
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
 * Sentinel identities for the dual-owner tables' RESTRICTIVE trusted
 * boundary. They name WHICH trusted path is running — the caller's own
 * authorization (platform-admin route check, manage-token hash match,
 * scheduled sweep, user-initiated erasure) is the gate; binding the operator
 * context only declares the path so a context-free statement fails closed.
 */
export const MYRA_TRUSTED_OPERATOR = "myra:operator"
export const MYRA_TRUSTED_MANAGE_TOKEN = "myra:manage-token"
export const MYRA_TRUSTED_INTERNAL = "myra:internal"
export const MYRA_TRUSTED_RETENTION = "myra:retention"

/**
 * Run `fn` inside the principal's RLS binding. When `db` is already a
 * transaction (caller bound the scope), the callback reuses it directly.
 * Operator principals bind through withMyraOperatorRLS — the route-level
 * platform-admin check is the authorization, the binding declares it.
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
  return withMyraOperatorRLS(MYRA_TRUSTED_OPERATOR, fn)
}

/**
 * Run `fn` on the operator-bound trusted path when `db` is the ambient
 * client, or directly on `db` when a bound transaction is already in hand.
 * For internal Myra work that legitimately spans owners — public slot
 * computation, manage-token booking lookups, reconcile sweeps — where no
 * owner context exists to bind.
 */
export async function withTrustedScope<T>(
  trustedId: string,
  fn: (tx: ScopedTransaction) => Promise<T>,
  db?: MyraDb
): Promise<T> {
  if (db && db !== prisma) return fn(db as ScopedTransaction)
  return withMyraOperatorRLS(trustedId, fn)
}
