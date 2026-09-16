/**
 * @lyrashield/myra/server — server-only Myra surface. Never imported by the
 * client bundles or the marketing Worker.
 */
import { registerAccountDeletionHooks } from "@lyrashield/db"
import { getCalendarAdapter } from "./calendar/adapter"

// Arm account deletion with provider-side demo cancellation. The db package
// owns the erasure transaction but cannot import this adapter (dependency
// direction), so the server bundle registers the cancel on import — any
// environment that serves Myra cancels orphaned calendar events when an
// account is deleted. Best-effort inside the transaction; the row scrub is
// the durable erasure.
registerAccountDeletionHooks({
  cancelCalendarEvent: (providerEventId) => getCalendarAdapter().cancelEvent(providerEventId),
})

export { MyraServiceError, err, toMyraError } from "./errors"
export { allowedToolsFor, isToolAllowed } from "./policy"
export {
  issuePublicSession,
  verifyPublicToken,
  readPublicToken,
  hashPublicToken,
  PUBLIC_SESSION_HEADER,
} from "./session"
export { resolveMyraRequest, type ResolvedMyraRequest } from "./context"
export { withOwnerScope, ownerWhere, type MyraDb } from "./db"
export {
  createProposal,
  confirm,
  cancel,
  invalidateForConversation,
  expireSweep,
  hashOperationPayload,
  OutcomeUnknownError,
  type OperationContext,
  type OperationExecutor,
  type ExecutorOutcome,
  type ProposalRecord,
} from "./operations"
export { searchKnowledge, withdrawEntry, listReviewQueue, type KnowledgeHit } from "./kb"
export {
  requestIdentityCode,
  confirmIdentityCode,
  hasVerifiedEmail,
  findVerifiedEmail,
  type IdentityPurpose,
} from "./verify"
export { auditEvent, type MyraActorType, type AuditFields } from "./audit"
export {
  checkBudget,
  recordCost,
  monthlyBudgetCapUsd,
  maximumTurnCostUsd,
  reserveGenerationBudget,
  settleGenerationBudget,
  type BudgetState,
} from "./budget"
export {
  getCalendarAdapter,
  zonedParts,
  zonedWallToUtc,
  CalendarTimeoutError,
  CalendarConflictError,
  type CalendarAdapter,
  type CalendarEventSpec,
  type CalendarEventResult,
  type BusyWindow,
} from "./calendar/adapter"
export { MockCalendarAdapter } from "./calendar/mock"
export { GoogleCalendarAdapter } from "./calendar/google"
export {
  getProvider,
  MockProvider,
  AzureProvider,
  sanitizeAnswerMarkdown,
  type ModelProvider,
  type ModelGenerateInput,
  type ModelGenerateOutput,
} from "./provider"
export { runTaskLoop, newTraceId, classifyIntent, type LoopArgs } from "./loop"
export { pruneMyraRetention, type RetentionCounts } from "./retention"
export {
  handleMessage,
  suggest,
  confirmProposal,
  cancelProposal,
  listOwnCases,
  getOwnCase,
  replyToOwnCase,
  clearAccountMemory,
  getDemoSlots,
  manageBooking,
  listOperatorCases,
  getOperatorCase,
  operatorReply,
  operatorTakeover,
  operatorRelease,
  operatorAssign,
  operatorSetStatus,
  type HandleMessageInput,
} from "./service"
export { MYRA_TOOLS, runTool } from "./tools/registry"
export type { MyraToolContext, MyraToolResult, ProposalSummary } from "./tools/types"
export { computeDemoSlots, reconcileDemoBooking } from "./tools/demo"
export type { DemoSlot } from "./tools/demo"
