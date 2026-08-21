/**
 * Distribution-facing tool policy data.
 *
 * Kept in a dependency-free module (no handler imports) so downstream
 * packaging tooling can consume the catalog-derived mutating-tool list without
 * pulling in server, transport, or SDK code. `tool-policy.test.ts` enforces
 * that this list stays identical to the `mutating: true` entries in
 * `createAllTools()` — update the catalog first; this file follows it.
 */
export const MUTATING_TOOL_NAMES = [
  "lyrashield_scan_target",
  "lyrashield_create_report",
  "lyrashield_run_pr_scan",
  "lyrashield_record_fix_proposal",
  "lyrashield_verify_fix",
] as const

export type MutatingToolName = (typeof MUTATING_TOOL_NAMES)[number]
