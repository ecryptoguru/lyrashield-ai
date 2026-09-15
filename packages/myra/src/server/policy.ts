/**
 * Capability policy — maps a resolved principal to the tool set it may
 * invoke. Resolved outside the model: user/retrieved text can never widen
 * this set. Operators are not chat principals; their APIs are separate
 * functions in service.ts gated by the platform-operator check upstream.
 */
import type { MyraPrincipal, MyraToolName } from "../contracts"

/** Anonymous public-session tools (marketing + unauthenticated dashboard). */
const ANONYMOUS_TOOLS: readonly MyraToolName[] = [
  "search_public_help",
  "read_product_catalog",
  "instant_suggest",
  "guide_workflow",
  "propose_support_case",
  "submit_support_case", // requires a verified reply email at execution
  "read_own_case",
  "send_case_reply", // own verified cases only
  "get_demo_slots",
  "book_demo", // requires a verified attendee at execution
  "manage_own_demo",
]

/** Authenticated browser-session users get the public set plus account tools. */
const USER_EXTRA_TOOLS: readonly MyraToolName[] = [
  "get_my_context",
  "get_scan_status",
  "get_connection_health",
  "start_guided_flow",
  "advance_guided_flow",
  "verify_resolution",
  "read_memory",
  "write_memory",
  "attach_trace",
]

const ANONYMOUS_SET: ReadonlySet<MyraToolName> = new Set(ANONYMOUS_TOOLS)
const USER_SET: ReadonlySet<MyraToolName> = new Set([
  ...ANONYMOUS_TOOLS,
  ...USER_EXTRA_TOOLS,
])

export function allowedToolsFor(principal: MyraPrincipal): ReadonlySet<MyraToolName> {
  if (principal.kind === "user") return USER_SET
  if (principal.kind === "anonymous") return ANONYMOUS_SET
  return new Set<MyraToolName>()
}

export function isToolAllowed(principal: MyraPrincipal, name: MyraToolName): boolean {
  return allowedToolsFor(principal).has(name)
}
