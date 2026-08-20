/**
 * @lyrashield/billing — Cloud billing, metering, and entitlements.
 *
 * This package is the single import surface for all billing logic:
 * - Plan definitions (re-exported from @lyrashield/pricing)
 * - Entitlement checks (scan depth, target limits, usage balance)
 * - Usage metering (agent-minute recording, pool grants, pack crediting)
 * - Subscription sync (Polar + Razorpay → workspace state)
 * - Trial lifecycle (start, state, expiry)
 * - Grace period state machine (mid-scan balance exhaustion)
 * - GeoIP routing (Polar USD vs Razorpay INR)
 * - Overage debit (Team plan opt-in)
 * - Refund reversal
 * - Pack expiry
 */

// Plans re-export
export * from "./plans"

// Entitlements
export {
  assertScanAllowed,
  assertTargetAllowed,
  type ScanModeAllowed,
  type EntitlementResult,
  type TargetAllowedResult,
} from "./entitlements"

// Usage balance
export { getUsageBalance, type UsageBalance, type PackBalance } from "./usage/balance"

// Usage metering
export {
  recordAgentMinutes,
  type RecordAgentMinutesOptions,
  type RecordAgentMinutesResult,
} from "./usage/meter"

// Usage grants
export { grantMonthlyPool, type GrantSource, type GrantMonthlyPoolResult } from "./usage/grants"

// Usage packs
export { creditTopUp, type PackProvider, type CreditTopUpResult } from "./usage/packs"

// Usage expiry
export { expirePacks, type ExpirePacksResult } from "./usage/expiry"

// Usage overage
export { debitOverage, type DebitOverageResult } from "./usage/overage"

// Usage refund
export { reverseRefund, type ReverseRefundResult } from "./usage/refund"

// Subscription sync
export {
  syncSubscription,
  downgradeToFree,
  type SubscriptionProvider,
  type SubscriptionStatus,
  type BillingInterval,
  type SyncSubscriptionParams,
} from "./sync"

// Geo routing
export {
  resolveRegion,
  regionToProvider,
  resolveProvider,
  getClientIp,
  type BillingRegion,
  type BillingProvider,
} from "./geo"

// Trial
export {
  startTrial,
  getTrialState,
  blockOnExpiry,
  TRIAL_DURATION_DAYS,
  TRIAL_AGENT_MINUTES,
  TRIAL_TARGET_CAP,
  type TrialState,
} from "./trial"

// Grace
export { enterGrace, resetGrace, getGraceState, GRACE_CAP_MS, type GraceState } from "./grace"

// Polar provider
export {
  getPolarClient,
  createPolarCheckout,
  createPolarOneTimeCheckout,
  getPolarPortalUrl,
} from "./providers/polar/client"
export {
  validatePolarWebhook,
  isHandledPolarEvent,
  type PolarWebhookEvent,
} from "./providers/polar/webhooks"
export { processPolarEvent, type PolarAdapterResult } from "./providers/polar/adapter"
export { resolveProviderId } from "./provider-ids"

// Razorpay provider
export {
  getRazorpayClient,
  createRazorpaySubscription,
  getRazorpaySubscriptionCycleCount,
  createRazorpayPaymentLink,
  cancelRazorpaySubscription,
  getRazorpaySubscription,
} from "./providers/razorpay/client"
export {
  validateRazorpayWebhook,
  isHandledRazorpayEvent,
  type RazorpayWebhookEvent,
} from "./providers/razorpay/webhooks"
export { processRazorpayEvent, type RazorpayAdapterResult } from "./providers/razorpay/adapter"
