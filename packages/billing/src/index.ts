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
  evaluateScanEntitlement,
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

export {
  evaluateBillingAdmission,
  getBillingAdmission,
  getLocalBillingAdmission,
  type BillingAdmissionMode,
  type LocalBillingAdmissionMode,
  type BillingAdmissionReason,
  type BillingAdmissionDecision,
} from "./admission"

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
export { resolveProviderId, resolveProviderKey } from "./provider-ids"
export {
  billingQuoteNotes,
  signBillingQuote,
  verifyBillingQuote,
  BillingQuoteConfigError,
  type BillingQuote,
  type QuoteKind,
} from "./provider-quote"
export {
  assertProviderCatalogEvent,
  resolvePolarCatalogEvent,
  resolveRazorpayCatalogEvent,
  ProviderCatalogConfigError,
  type CatalogResolution,
} from "./provider-catalog-validation"

// Razorpay provider
export {
  getRazorpayClient,
  createRazorpaySubscription,
  getRazorpaySubscriptionCycleCount,
  createRazorpayPaymentLink,
  cancelRazorpayPaymentLink,
  cancelRazorpaySubscription,
  getRazorpaySubscription,
} from "./providers/razorpay/client"
export {
  validateRazorpayWebhook,
  isHandledRazorpayEvent,
  resolveRazorpayEventIdentity,
  type RazorpayWebhookEvent,
} from "./providers/razorpay/webhooks"
export { processRazorpayEvent, type RazorpayAdapterResult } from "./providers/razorpay/adapter"
export { WebhookAuthError, WebhookPayloadError } from "./webhook-errors"

// Normalized provider domain events (finding 18A)
export {
  normalizeProviderEvent,
  type BillingProviderName,
  type ProductKind,
  type NormalizedEventKind,
  type CanonicalMoney,
  type NormalizedBillingEvent,
  type SubscriptionPaidEvent,
  type SubscriptionRenewedEvent,
  type LocalPurchasePaidEvent,
  type RefundCompletedEvent,
  type EntitlementTransitionedEvent,
} from "./domain-events"

// Durable required-track execution + state (finding 12)
export {
  WEBHOOK_TRACK_IDS,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  computeApplicableTracks,
  ensureWebhookTrackRows,
  markTrackSucceeded,
  markTrackFailed,
  syncDerivedProcessedState,
  boundTrackError,
  executeWebhookTrack,
  runApplicableTracks,
  retryWebhookTrack,
  type WebhookTrackId,
  type WebhookTrackHandlers,
  type TrackFailure,
  type TrackRunSummary,
  type WebhookTrackRetryOutcome,
} from "./webhook-tracks"

// License fulfillment (Track B, provider-generalized)
export {
  issueLicenseForProviderOrder,
  issueSignedLicense,
  resolvePublishedFallbackBuild,
  resolveSigningPrivateKey,
  resolveSigningKeyId,
  resolveSigningPublicKey,
  parseLocalProductIds,
  generateLicenseKey,
  hashLicenseKey,
  generateRetrievalToken,
  hashRetrievalToken,
  encryptRetrievalKey,
  sendLicenseIssuedEmail,
  sendLicenseRetrievalEmail,
  retrieveLicenseByToken,
  computeUpdateEligibleUntil,
  validateSeatCountForSku,
  machineCapForSku,
  isIndividualSku,
  isTeamSku,
  INDIVIDUAL_MACHINE_CAP,
  TEAM_MIN_SEATS,
  RETRIEVAL_TOKEN_EXPIRY_DAYS,
  RETRIEVAL_TOKEN_EXPIRY_MS,
  FULFILLMENT_STATUS,
} from "./license-fulfillment"
