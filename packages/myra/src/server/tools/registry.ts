/**
 * Tool registry — the fixed allowlist the agent may invoke. The model cannot
 * extend it; `runTool` enforces policy + input validation + output caps.
 */
import { z } from "zod"
import type { MyraToolDefinition, MyraToolName } from "../../contracts"
import { isToolAllowed } from "../policy"
import { err } from "../errors"
import { runReadProductCatalog } from "./catalog"
import {
  runInstantSuggest,
  runSearchPublicHelp,
  instantSuggestInput,
  searchPublicHelpInput,
} from "./help"
import { getMyContextInput, runGetMyContext } from "./context"
import {
  getConnectionHealthInput,
  getScanStatusInput,
  runGetConnectionHealth,
  runGetScanStatus,
} from "./diagnostics"
import { guideWorkflowInput, runGuideWorkflow } from "./guide"
import {
  proposeSupportCaseInput,
  readOwnCaseInput,
  runProposeSupportCase,
  runReadOwnCase,
  runSendCaseReply,
  runSubmitSupportCase,
  sendCaseReplyInput,
  submitSupportCaseInput,
} from "./cases"
import {
  bookDemoInput,
  getDemoSlotsInput,
  manageOwnDemoInput,
  runBookDemo,
  runGetDemoSlots,
  runManageOwnDemo,
} from "./demo"
import {
  advanceGuidedFlowInput,
  runAdvanceGuidedFlow,
  runStartGuidedFlow,
  runVerifyResolution,
  startGuidedFlowInput,
  verifyResolutionInput,
} from "./flows-tools"
import { readMemoryInput, runReadMemory, runWriteMemory, writeMemoryInput } from "./memory"
import { attachTraceInput, runAttachTrace } from "./trace"
import type { MyraToolContext, MyraToolResult, ToolRunner } from "./types"

export const MYRA_TOOLS: Record<MyraToolName, MyraToolDefinition> = {
  search_public_help: {
    name: "search_public_help",
    audience: "public",
    effect: "read",
    description: "Search approved public knowledge entries.",
    maxOutputBytes: 8192,
  },
  read_product_catalog: {
    name: "read_product_catalog",
    audience: "public",
    effect: "read",
    description: "Current plans, prices, minute packs, Local SKUs and availability.",
    maxOutputBytes: 8192,
  },
  instant_suggest: {
    name: "instant_suggest",
    audience: "public",
    effect: "read",
    description: "Type-ahead suggestions from public knowledge. No model call.",
    maxOutputBytes: 4096,
  },
  get_my_context: {
    name: "get_my_context",
    audience: "authenticated",
    effect: "read",
    description: "Effective entitlement and setup summary for the caller's account.",
    maxOutputBytes: 4096,
  },
  get_scan_status: {
    name: "get_scan_status",
    audience: "authenticated",
    effect: "read",
    description: "Latest scan status, finished time and verdict. Never findings content.",
    maxOutputBytes: 2048,
  },
  get_connection_health: {
    name: "get_connection_health",
    audience: "authenticated",
    effect: "read",
    description: "Integration connection states. Never credentials.",
    maxOutputBytes: 4096,
  },
  guide_workflow: {
    name: "guide_workflow",
    audience: "public",
    effect: "read",
    description: "Role-valid route links and suggested guided flows.",
    maxOutputBytes: 8192,
  },
  propose_support_case: {
    name: "propose_support_case",
    audience: "public",
    effect: "draft",
    description: "Draft a support case for user review.",
    maxOutputBytes: 8192,
  },
  submit_support_case: {
    name: "submit_support_case",
    audience: "public",
    effect: "confirmed-write",
    description: "Persist a confirmed support case once and notify the inbox.",
    maxOutputBytes: 4096,
  },
  read_own_case: {
    name: "read_own_case",
    audience: "public",
    effect: "read",
    description: "Read a support case owned by this principal, with replies.",
    maxOutputBytes: 8192,
  },
  send_case_reply: {
    name: "send_case_reply",
    audience: "public",
    effect: "confirmed-write",
    description: "Append a user-authored reply. The Send click is the confirmation.",
    maxOutputBytes: 4096,
  },
  get_demo_slots: {
    name: "get_demo_slots",
    audience: "public",
    effect: "read",
    description: "Bookable demo slots within the scheduling rules.",
    maxOutputBytes: 8192,
  },
  book_demo: {
    name: "book_demo",
    audience: "public",
    effect: "confirmed-write",
    description: "Book a demo for a verified attendee via the calendar adapter.",
    maxOutputBytes: 4096,
  },
  manage_own_demo: {
    name: "manage_own_demo",
    audience: "public",
    effect: "confirmed-write",
    description: "Cancel or reschedule a booking via its manage token.",
    maxOutputBytes: 4096,
  },
  start_guided_flow: {
    name: "start_guided_flow",
    audience: "authenticated",
    effect: "draft",
    description: "Start a resumable guided flow session.",
    maxOutputBytes: 4096,
  },
  advance_guided_flow: {
    name: "advance_guided_flow",
    audience: "authenticated",
    effect: "draft",
    description: "Advance a flow; checked steps re-run their tool first.",
    maxOutputBytes: 4096,
  },
  verify_resolution: {
    name: "verify_resolution",
    audience: "authenticated",
    effect: "read",
    description: "Re-run the failing checks and report observed resolution state.",
    maxOutputBytes: 4096,
  },
  read_memory: {
    name: "read_memory",
    audience: "authenticated",
    effect: "read",
    description: "Read the account's allowlisted support memory.",
    maxOutputBytes: 4096,
  },
  write_memory: {
    name: "write_memory",
    audience: "authenticated",
    effect: "draft",
    description: "Write an allowlisted support preference. Never authority-bearing.",
    maxOutputBytes: 2048,
  },
  attach_trace: {
    name: "attach_trace",
    audience: "authenticated",
    effect: "read",
    description: "Bind a message traceId from this conversation to a case draft.",
    maxOutputBytes: 2048,
  },
}

const INPUT_SCHEMAS: Partial<Record<MyraToolName, z.ZodType<unknown>>> = {
  search_public_help: searchPublicHelpInput,
  instant_suggest: instantSuggestInput,
  get_my_context: getMyContextInput,
  get_scan_status: getScanStatusInput,
  get_connection_health: getConnectionHealthInput,
  guide_workflow: guideWorkflowInput,
  propose_support_case: proposeSupportCaseInput,
  submit_support_case: submitSupportCaseInput,
  read_own_case: readOwnCaseInput,
  send_case_reply: sendCaseReplyInput,
  get_demo_slots: getDemoSlotsInput,
  book_demo: bookDemoInput,
  manage_own_demo: manageOwnDemoInput,
  start_guided_flow: startGuidedFlowInput,
  advance_guided_flow: advanceGuidedFlowInput,
  verify_resolution: verifyResolutionInput,
  read_memory: readMemoryInput,
  write_memory: writeMemoryInput,
  attach_trace: attachTraceInput,
}

const RUNNERS: Record<MyraToolName, ToolRunner> = {
  search_public_help: runSearchPublicHelp,
  read_product_catalog: runReadProductCatalog,
  instant_suggest: runInstantSuggest,
  get_my_context: runGetMyContext,
  get_scan_status: runGetScanStatus,
  get_connection_health: runGetConnectionHealth,
  guide_workflow: runGuideWorkflow,
  propose_support_case: runProposeSupportCase,
  submit_support_case: runSubmitSupportCase,
  read_own_case: runReadOwnCase,
  send_case_reply: runSendCaseReply,
  get_demo_slots: runGetDemoSlots,
  book_demo: runBookDemo,
  manage_own_demo: runManageOwnDemo,
  start_guided_flow: runStartGuidedFlow,
  advance_guided_flow: runAdvanceGuidedFlow,
  verify_resolution: runVerifyResolution,
  read_memory: runReadMemory,
  write_memory: runWriteMemory,
  attach_trace: runAttachTrace,
}

/** Trim oversized tool output: drop trailing items from the largest arrays. */
function capOutput(result: MyraToolResult, maxBytes: number): MyraToolResult {
  let size = JSON.stringify(result).length
  if (size <= maxBytes) return result
  const data = { ...result.data }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 1) {
      let arr = value as unknown[]
      while (arr.length > 1 && size > maxBytes) {
        arr = arr.slice(0, Math.ceil(arr.length / 2))
        data[key] = arr
        size = JSON.stringify({ ...result, data }).length
      }
    }
  }
  return { ...result, data }
}

export async function runTool(
  name: MyraToolName,
  ctx: MyraToolContext,
  input: unknown
): Promise<MyraToolResult> {
  if (!isToolAllowed(ctx.principal, name)) {
    throw err("FORBIDDEN", "That capability is not available here.")
  }
  const schema = INPUT_SCHEMAS[name]
  const parsed = schema ? schema.parse(input ?? {}) : input
  const result = await RUNNERS[name](ctx, parsed)
  return capOutput(result, MYRA_TOOLS[name].maxOutputBytes)
}
