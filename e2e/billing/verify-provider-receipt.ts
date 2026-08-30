import { createHash } from "node:crypto"
import { getSystemPrisma } from "../../packages/db/src/index"
import {
  isProviderSubscriptionLifecycleReceipt,
  selectPolarSubscriptionCancellationEvent,
  selectPolarSubscriptionReceiptEvent,
  selectRazorpaySubscriptionCancellationEvent,
  selectRazorpaySubscriptionReceiptEvent,
} from "../../packages/billing/src/receipt-event-selection"

const provider = process.env.BILLING_RECEIPT_PROVIDER
let eventId = process.env.BILLING_RECEIPT_EVENT_ID
const workspaceId = process.env.BILLING_RECEIPT_WORKSPACE_ID
const kind = process.env.BILLING_RECEIPT_KIND
const objectId = process.env.BILLING_RECEIPT_OBJECT_ID
const phase = process.env.BILLING_RECEIPT_PHASE ?? "purchase"
const resolveRazorpaySubscriptionCharge =
  process.env.BILLING_RECEIPT_RESOLVE_RAZORPAY_SUBSCRIPTION_CHARGE === "true"
const resolveRazorpaySubscriptionCancellation =
  process.env.BILLING_RECEIPT_RESOLVE_RAZORPAY_SUBSCRIPTION_CANCELLATION === "true"
const resolvePolarSubscriptionPurchase =
  process.env.BILLING_RECEIPT_RESOLVE_POLAR_SUBSCRIPTION_PURCHASE === "true"
const resolvePolarSubscriptionCancellation =
  process.env.BILLING_RECEIPT_RESOLVE_POLAR_SUBSCRIPTION_CANCELLATION === "true"
const resolverCount = [
  resolveRazorpaySubscriptionCharge,
  resolveRazorpaySubscriptionCancellation,
  resolvePolarSubscriptionPurchase,
  resolvePolarSubscriptionCancellation,
].filter(Boolean).length
const hasProviderSubscriptionResolver = resolverCount > 0

const parseExpectedCount = (name: string, fallback?: number) => {
  const raw = process.env[name]
  if (!raw && fallback !== undefined) return fallback
  const value = Number.parseInt(raw ?? "", 10)
  if (!Number.isSafeInteger(value) || value < 0 || `${value}` !== raw) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const immutable = {
  sourceSha: process.env.BILLING_RECEIPT_SOURCE_SHA ?? "",
  webDigest: process.env.BILLING_RECEIPT_WEB_DIGEST ?? "",
  migrationDigest: process.env.BILLING_RECEIPT_MIGRATION_DIGEST ?? "",
  e2eDigest: process.env.BILLING_RECEIPT_E2E_DIGEST ?? "",
  revision: process.env.BILLING_RECEIPT_REVISION ?? "",
}

if (
  !["polar", "razorpay"].includes(provider ?? "") ||
  (!hasProviderSubscriptionResolver && !eventId) ||
  !workspaceId ||
  !["subscription", "pack"].includes(kind ?? "") ||
  !objectId ||
  (!hasProviderSubscriptionResolver && !/^[A-Za-z0-9_:-]{1,191}$/.test(eventId ?? "")) ||
  !/^[A-Za-z0-9_:-]{1,191}$/.test(objectId) ||
  !/^[a-z][a-z0-9_-]{1,63}$/.test(phase) ||
  !/^[0-9a-f]{40}$/.test(immutable.sourceSha) ||
  ![immutable.webDigest, immutable.migrationDigest, immutable.e2eDigest].every((digest) =>
    /^sha256:[0-9a-f]{64}$/.test(digest)
  ) ||
  !/^[a-z0-9-]+--[a-z0-9]+$/.test(immutable.revision)
) {
  throw new Error(
    "Provider receipt verifier requires valid provider, event, workspace, kind, and object IDs"
  )
}
if (resolverCount > 1) {
  throw new Error("Select only one provider subscription receipt resolver")
}

const prisma = getSystemPrisma()
const verifiedProvider = provider as "polar" | "razorpay"
let resolvedEventType: string | null = null
if (hasProviderSubscriptionResolver) {
  const resolvingRazorpay =
    resolveRazorpaySubscriptionCharge || resolveRazorpaySubscriptionCancellation
  if (
    kind !== "subscription" ||
    (resolvingRazorpay && verifiedProvider !== "razorpay") ||
    (!resolvingRazorpay && verifiedProvider !== "polar")
  ) {
    throw new Error("Automatic receipt event resolver does not match the provider subscription")
  }
  const candidates = await prisma.webhookEvent.findMany({
    where: {
      provider: verifiedProvider,
      workspaceId,
      eventType: resolveRazorpaySubscriptionCancellation
        ? "subscription.cancelled"
        : resolveRazorpaySubscriptionCharge
          ? { in: ["subscription.charged", "subscription.activated"] }
          : resolvePolarSubscriptionCancellation
            ? { in: ["subscription.canceled", "subscription.revoked"] }
            : { in: ["subscription.active", "subscription.created"] },
      processed: true,
    },
    select: { externalId: true, eventType: true, payload: true },
  })
  const selected = resolveRazorpaySubscriptionCancellation
    ? selectRazorpaySubscriptionCancellationEvent(candidates, objectId)
    : resolveRazorpaySubscriptionCharge
      ? selectRazorpaySubscriptionReceiptEvent(candidates, objectId)
      : resolvePolarSubscriptionCancellation
        ? selectPolarSubscriptionCancellationEvent(candidates, objectId)
        : selectPolarSubscriptionReceiptEvent(candidates, objectId)
  eventId = selected.externalId
  resolvedEventType = selected.eventType
}
const event = await prisma.webhookEvent.findUnique({
  where: { provider_externalId: { provider: verifiedProvider, externalId: eventId } },
})
if (!event || event.workspaceId !== workspaceId || !event.processed) {
  throw new Error("Provider receipt did not produce one processed workspace-bound webhook event")
}
const tracks = await prisma.webhookEventTrack.findMany({
  where: { webhookEventId: event.id },
  select: { track: true, status: true, attempts: true },
})
if (!tracks.some((track) => track.track === "billing" && track.status === "succeeded")) {
  throw new Error("Provider receipt billing track is incomplete")
}
if (tracks.some((track) => track.status !== "succeeded")) {
  throw new Error("Provider receipt has an unresolved replay or retry")
}

let expectedState: Record<string, string | number | boolean>
let observedState: Record<string, string | number | boolean>
const expectedCommissionCount = parseExpectedCount("BILLING_RECEIPT_COMMISSION_COUNT", 0)
const expectedCommissionStatus = process.env.BILLING_RECEIPT_COMMISSION_STATUS
let commissionStatuses: string[]

if (kind === "subscription") {
  const account = await prisma.billingAccount.findUnique({ where: { workspaceId } })
  if (
    !account ||
    account.provider !== verifiedProvider ||
    account.externalId !== objectId ||
    account.currentPlan !== process.env.BILLING_RECEIPT_PLAN ||
    account.interval !== process.env.BILLING_RECEIPT_INTERVAL ||
    account.status !== process.env.BILLING_RECEIPT_STATUS
  ) {
    throw new Error("Provider receipt subscription state does not match expected provider result")
  }
  expectedState = {
    plan: process.env.BILLING_RECEIPT_PLAN ?? "",
    interval: process.env.BILLING_RECEIPT_INTERVAL ?? "",
    status: process.env.BILLING_RECEIPT_STATUS ?? "",
  }
  observedState = {
    plan: account.currentPlan,
    interval: account.interval ?? "",
    status: account.status,
  }
  const receiptEventType = resolvedEventType ?? event.eventType
  if (
    !isProviderSubscriptionLifecycleReceipt({
      provider: verifiedProvider,
      phase,
      eventType: receiptEventType,
      status: account.status,
      canceledAt: account.canceledAt !== null,
    })
  ) {
    throw new Error(`Provider receipt ${phase} lifecycle is incomplete`)
  }
  if (phase === "cancellation") {
    expectedState.cancellationRecorded = true
    observedState.cancellationRecorded =
      account.status === "canceled" || account.canceledAt !== null
  }
  commissionStatuses = (
    await prisma.commission.findMany({
      where: { conversion: { subscription: { providerSubscriptionId: objectId } } },
      select: { status: true },
    })
  ).map((commission) => commission.status)
} else {
  const minutes = Number.parseInt(process.env.BILLING_RECEIPT_MINUTES ?? "", 10)
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error("Provider receipt pack verification requires positive expected minutes")
  }
  const remainingMinutes = parseExpectedCount("BILLING_RECEIPT_REMAINING_MINUTES", minutes)
  const pack = await prisma.minutePack.findUnique({
    where: { workspaceId_externalId: { workspaceId, externalId: objectId } },
  })
  if (
    !pack ||
    pack.provider !== verifiedProvider ||
    pack.minutes !== minutes ||
    pack.remainingMinutes !== remainingMinutes
  ) {
    throw new Error("Provider receipt minute pack does not match expected provider result")
  }
  commissionStatuses = (
    await prisma.commission.findMany({
      where: { conversion: { externalId: objectId } },
      select: { status: true },
    })
  ).map((commission) => commission.status)
  if (expectedCommissionCount !== 0) {
    throw new Error("Minute-pack receipt commission count must be zero")
  }
  expectedState = {
    minutes,
    remainingMinutes,
  }
  observedState = {
    minutes: pack.minutes,
    remainingMinutes: pack.remainingMinutes,
  }
}

if (commissionStatuses.length !== expectedCommissionCount) {
  throw new Error("Provider receipt commission count does not match the expected lifecycle state")
}
if (expectedCommissionCount > 0) {
  if (!expectedCommissionStatus || !/^[A-Z][A-Z_]{1,31}$/.test(expectedCommissionStatus)) {
    throw new Error("BILLING_RECEIPT_COMMISSION_STATUS is required for expected commissions")
  }
  if (commissionStatuses.some((status) => status !== expectedCommissionStatus)) {
    throw new Error(
      "Provider receipt commission status does not match the expected lifecycle state"
    )
  }
} else if (expectedCommissionStatus) {
  throw new Error("BILLING_RECEIPT_COMMISSION_STATUS requires a non-zero commission count")
}
expectedState.commissions = expectedCommissionCount
expectedState.commissionStatus = expectedCommissionStatus ?? "not_applicable"
observedState.commissions = commissionStatuses.length
observedState.commissionStatus =
  commissionStatuses.length > 0
    ? [...new Set(commissionStatuses)].sort().join(",")
    : "not_applicable"

const auditAction = process.env.BILLING_RECEIPT_AUDIT_ACTION
const auditResourceId = process.env.BILLING_RECEIPT_AUDIT_RESOURCE_ID || objectId
const expectedAuditCount = parseExpectedCount(
  "BILLING_RECEIPT_AUDIT_COUNT",
  auditAction ? undefined : 0
)
let auditCount = 0
if (auditAction) {
  if (!/^[a-z][a-z0-9_.-]{1,95}$/.test(auditAction)) {
    throw new Error("BILLING_RECEIPT_AUDIT_ACTION is invalid")
  }
  if (!/^[A-Za-z0-9_:-]{1,191}$/.test(auditResourceId)) {
    throw new Error("BILLING_RECEIPT_AUDIT_RESOURCE_ID is invalid")
  }
  auditCount = await prisma.auditLog.count({
    where: { workspaceId, action: auditAction, resourceId: auditResourceId },
  })
  if (auditCount !== expectedAuditCount) {
    throw new Error("Provider receipt audit count does not match the expected lifecycle state")
  }
} else if (expectedAuditCount !== 0) {
  throw new Error("BILLING_RECEIPT_AUDIT_ACTION is required for a non-zero audit count")
}

const receipt = {
  schemaVersion: 1,
  ...immutable,
  provider: verifiedProvider,
  testEnvironment: verifiedProvider === "polar" ? "sandbox" : "test_mode",
  lifecyclePhase: phase,
  eventType: resolvedEventType ?? event.eventType,
  kind,
  identitySource: event.identitySource ?? "unknown",
  identities: {
    eventSha256: sha256(eventId),
    objectSha256: sha256(objectId),
    workspaceSha256: sha256(workspaceId),
    auditResourceSha256: auditAction ? sha256(auditResourceId) : "not_applicable",
  },
  expectedState,
  observedState,
  audit: {
    action: auditAction ?? "not_applicable",
    expectedCount: expectedAuditCount,
    count: auditCount,
  },
  tracks: tracks
    .map((track) => ({ track: track.track, status: track.status, attempts: track.attempts }))
    .sort((left, right) => left.track.localeCompare(right.track)),
  unresolvedRetries: false,
  workflowCleanupResult: "pending",
}
const canonical = JSON.stringify(receipt)
const artifact = { ...receipt, artifactChecksum: sha256(canonical) }

console.log(
  `Provider-delivered ${verifiedProvider} ${kind} receipt verified without identifiers or payloads.`
)
console.log(
  `Provider-receipt-artifact-v1 ${Buffer.from(JSON.stringify(artifact)).toString("base64")}`
)
