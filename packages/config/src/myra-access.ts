/**
 * The shared Myra dashboard admission rule. All verified accounts may use
 * the interactive support surface; API and UI enforce the same condition.
 *
 * The former MYRA_ALLOWED_EMAILS allowlist is gone (#768 opened Myra to every
 * verified account and the list stopped gating anything). This function is the
 * single place the rule lives, so the dashboard layout and the API layer
 * cannot drift.
 */
export function myraDashboardAllowed(input: { emailVerified: boolean }): boolean {
  return input.emailVerified
}
