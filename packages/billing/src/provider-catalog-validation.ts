import { env } from "@lyrashield/config"
import {
  LOCAL_SKU_MAP,
  MINUTE_PACK_MAP,
  teamOrderTotal,
  type CloudPlanId,
  type LocalSkuId,
  type PackId,
} from "@lyrashield/pricing"
import { WebhookPayloadError } from "./webhook-errors"
import { verifyBillingQuote, type QuoteKind } from "./provider-quote"

type UnknownRecord = Record<string, unknown>
type BillingInterval = "monthly" | "annual"

export type CatalogResolution =
  | { kind: "pack"; packId: PackId }
  | { kind: "plan"; plan: CloudPlanId; interval: BillingInterval }
  | { kind: "local"; sku: LocalSkuId }

export class ProviderCatalogConfigError extends Error {
  constructor(name: string) {
    super(`${name} is missing or malformed`)
    this.name = "ProviderCatalogConfigError"
  }
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function reject(): never {
  throw new WebhookPayloadError("Provider catalog evidence does not match the configured catalog")
}

function isLocalSkuId(value: string): value is LocalSkuId {
  return Object.hasOwn(LOCAL_SKU_MAP, value)
}

function isPackId(value: string): value is PackId {
  return Object.hasOwn(MINUTE_PACK_MAP, value)
}

function configuredProviderKey(
  raw: string | undefined,
  providerId: string,
  name: string,
  options: { optional?: boolean } = {}
): string | null {
  // Local products are optional: Cloud-only installs deliberately leave this
  // map blank. The Cloud map remains required for entitlement-bearing events.
  if (!raw) {
    if (options.optional) return null
    throw new ProviderCatalogConfigError(name)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProviderCatalogConfigError(name)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderCatalogConfigError(name)
  }
  const matches: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) {
      if (value.trim() === providerId) matches.push(key)
      continue
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.trim())
    ) {
      if (value.map((entry) => entry.trim()).includes(providerId)) matches.push(key)
      continue
    }
    throw new ProviderCatalogConfigError(name)
  }
  if (matches.length > 1) throw new ProviderCatalogConfigError(name)
  return matches[0] ?? null
}

function parsePlanKey(key: string): { plan: CloudPlanId; interval: BillingInterval } | null {
  const match = /^(starter|pro|launch_assurance)_(monthly|annual)$/.exec(key)
  if (!match) return null
  const plans: Record<string, CloudPlanId> = {
    starter: "STARTER",
    pro: "PRO",
    launch_assurance: "LAUNCH_ASSURANCE",
  }
  const plan = plans[match[1]!]
  const interval = match[2]
  if (!plan || (interval !== "monthly" && interval !== "annual")) return null
  return { plan, interval }
}

function requireMetadataAgreement(
  metadata: UnknownRecord,
  expected: { plan?: CloudPlanId; interval?: BillingInterval; packId?: PackId; sku?: LocalSkuId }
): void {
  if (expected.plan && text(metadata.plan ?? metadata.planId)?.toUpperCase() !== expected.plan)
    reject()
  if (expected.interval && text(metadata.interval) !== expected.interval) reject()
  if (expected.packId && text(metadata.packId) !== expected.packId) reject()
  if (expected.sku && text(metadata.productId ?? metadata.skuId) !== expected.sku) reject()
}

function requirePolarSubtotal(entity: UnknownRecord, amountMinor: number): void {
  if (text(entity.currency)?.toUpperCase() !== "USD") reject()
  if (integer(entity.subtotal_amount) !== amountMinor) reject()
}

function requireRazorpayQuote(
  kind: QuoteKind,
  catalogKey: string,
  metadata: UnknownRecord,
  payment: UnknownRecord
): void {
  if (text(payment.currency)?.toUpperCase() !== "INR") reject()
  const workspaceId = text(metadata.workspaceId ?? metadata.quoteWorkspaceId)
  const quotedRaw = text(metadata.quotedAmountMinor)
  const paidAmount = integer(payment.amount)
  if (!workspaceId || !quotedRaw || !/^\d+$/.test(quotedRaw) || paidAmount === null) reject()
  const quotedAmount = Number(quotedRaw)
  if (!Number.isSafeInteger(quotedAmount)) reject()
  // Pack quotes are payer-bound: the top-up route signs the authenticated
  // purchasing account into the quote and stamps it as metadata.accountId,
  // and the adapter credits exactly that note. Requiring the note and folding
  // it into the reconstructed quote binds the credited payer to the signed
  // quote — an account-free or grafted accountId can never verify. Local SKU
  // quotes stay account-free (anonymous buyer flow; no account exists yet).
  const accountId = kind === "pack" ? text(metadata.accountId) : null
  if (kind === "pack" && !accountId) reject()
  if (
    !verifyBillingQuote(
      {
        provider: "razorpay",
        kind,
        workspaceId,
        ...(accountId ? { accountId } : {}),
        catalogKey,
        amountMinor: quotedAmount,
        currency: "INR",
      },
      metadata,
      paidAmount
    )
  ) {
    reject()
  }
}

function polarProductId(data: UnknownRecord): string | null {
  return text(data.product_id ?? data.productId) ?? text(record(data.product).id)
}

export function resolvePolarCatalogEvent(
  eventType: string,
  data: UnknownRecord
): CatalogResolution | null {
  if (
    eventType === "refund.created" ||
    eventType === "order.refunded" ||
    eventType === "customer.state_changed"
  ) {
    return null
  }
  const grantsEntitlement = eventType === "order.paid" || eventType.startsWith("subscription.")
  if (!grantsEntitlement) return null

  const providerId = polarProductId(data)
  if (!providerId) reject()
  const metadata = record(data.metadata ?? data.notes)
  const cloudKey = configuredProviderKey(env.POLAR_PRODUCT_IDS, providerId, "POLAR_PRODUCT_IDS")
  const localKey = configuredProviderKey(
    env.POLAR_LOCAL_PRODUCT_IDS,
    providerId,
    "POLAR_LOCAL_PRODUCT_IDS",
    { optional: true }
  )
  if (cloudKey && localKey) {
    throw new ProviderCatalogConfigError("Polar product maps")
  }

  if (localKey) {
    if (!isLocalSkuId(localKey)) reject()
    const sku = localKey
    requireMetadataAgreement(metadata, { sku })
    if (eventType === "order.paid") {
      const seats = integer(data.seats) ?? integer(metadata.seats ?? metadata.seatCount) ?? 1
      requirePolarSubtotal(data, Math.round(teamOrderTotal(sku, seats) * 100))
    }
    return { kind: "local", sku }
  }

  if (!cloudKey) reject()
  if (isPackId(cloudKey)) {
    if (eventType !== "order.paid") reject()
    const packId = cloudKey
    requireMetadataAgreement(metadata, { packId })
    requirePolarSubtotal(data, MINUTE_PACK_MAP[packId].priceUsd * 100)
    return { kind: "pack", packId }
  }

  const plan = parsePlanKey(cloudKey)
  if (!plan) reject()
  requireMetadataAgreement(metadata, plan)
  return { kind: "plan", ...plan }
}

export function resolveRazorpayCatalogEvent(
  eventType: string,
  payload: unknown
): CatalogResolution | null {
  if (eventType === "refund.created") return null
  const sections = record(record(payload).payload)
  const payment = record(record(sections.payment).entity)
  const subscription = record(record(sections.subscription).entity)
  const paymentLink = record(record(sections.payment_link).entity)

  if (eventType.startsWith("subscription.")) {
    const planKey = configuredProviderKey(
      env.RAZORPAY_PLAN_IDS,
      text(subscription.plan_id) ?? "",
      "RAZORPAY_PLAN_IDS"
    )
    const plan = planKey ? parsePlanKey(planKey) : null
    if (!plan) reject()
    requireMetadataAgreement(record(subscription.notes), plan)
    if (eventType === "subscription.charged" && Object.keys(payment).length > 0) {
      if (text(payment.currency)?.toUpperCase() !== "INR") reject()
      const amount = integer(payment.amount)
      if (amount === null || amount <= 0) reject()
    }
    return { kind: "plan", ...plan }
  }

  if (eventType === "payment.captured") {
    const metadata = record(payment.notes)
    const packId = text(metadata.packId)
    if (!packId) return null
    if (!isPackId(packId)) reject()
    const resolved = packId
    requireRazorpayQuote("pack", resolved, metadata, payment)
    return { kind: "pack", packId: resolved }
  }

  if (eventType === "payment_link.paid") {
    // Razorpay copies payment-link notes onto the captured payment entity, so
    // both carriers normally agree. A conflicting second account field is
    // ambiguous payer evidence — never let one source silently override the
    // other; the signed quote binds a single credited account.
    const linkNotes = record(paymentLink.notes)
    const paymentNotes = record(payment.notes)
    const linkAccountId = text(linkNotes.accountId)
    const paymentAccountId = text(paymentNotes.accountId)
    if (linkAccountId && paymentAccountId && linkAccountId !== paymentAccountId) reject()
    const metadata = { ...linkNotes, ...paymentNotes }
    const packId = text(metadata.packId)
    if (packId) {
      if (!isPackId(packId)) reject()
      const resolved = packId
      requireRazorpayQuote("pack", resolved, metadata, payment)
      return { kind: "pack", packId: resolved }
    }
    const sku = text(metadata.productId ?? metadata.skuId)
    if (!sku) return null
    if (!isLocalSkuId(sku)) reject()
    const resolved = sku
    requireRazorpayQuote("local", resolved, metadata, payment)
    return { kind: "local", sku: resolved }
  }

  return null
}

export function assertProviderCatalogEvent(
  provider: "polar" | "razorpay",
  eventType: string,
  payload: unknown
): CatalogResolution | null {
  const root = record(payload)
  return provider === "polar"
    ? resolvePolarCatalogEvent(eventType, record(root.data))
    : resolveRazorpayCatalogEvent(eventType, root)
}
