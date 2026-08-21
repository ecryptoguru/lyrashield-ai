/**
 * Pure webhook payload predicates for product classification.
 *
 * Single source of truth shared by the billing domain-event normalizer and
 * the affiliate commission dispatcher — the SKU/pack catalogs live here in
 * @lyrashield/pricing, so detection must too (never duplicate the lists).
 */

import { LOCAL_SKUS, LOCAL_SKU_MAP } from "./local"
import { MINUTE_PACK_MAP, type PackId } from "./packs"

type UnknownRecord = Record<string, unknown>

function getProp(obj: UnknownRecord, key: string): unknown {
  return obj[key]
}

function getMetadata(payload: UnknownRecord): UnknownRecord | undefined {
  // Polar/PSP orders carry `metadata`; Razorpay entities carry the equivalent
  // `notes` bag. Treat them interchangeably for classification.
  const meta = payload.metadata ?? payload.notes
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as UnknownRecord
  }
  return undefined
}

/** Extract the product/SKU identifier from a provider order payload. */
export function extractProductId(payload: UnknownRecord): string | undefined {
  const meta = getMetadata(payload)
  return (getProp(payload, "skuId") ??
    getProp(payload, "sku_id") ??
    getProp(payload, "productId") ??
    getProp(payload, "product_id") ??
    (meta ? getProp(meta, "productId") : undefined)) as string | undefined
}

/**
 * Check if the order is for a Local SKU (one-time license).
 */
export function isLocalSkuOrderPayload(payload: UnknownRecord): boolean {
  const skuId = extractProductId(payload)
  if (!skuId) return false
  return skuId in LOCAL_SKU_MAP || LOCAL_SKUS.some((s) => s.id === skuId)
}

/**
 * Check if the order is for a prepaid minute pack (one-time, non-commissionable).
 *
 * Minute packs are identified by either:
 * - a `packId` in the order metadata matching a known MINUTE_PACK_MAP key
 *   (pack_100 / pack_250 / pack_500), set by the topup route, or
 * - a `productId`/`skuId` whose trailing segment is a known pack id
 *   (e.g. "polar_pack_100", "razorpay_pack_250").
 */
export function isMinutePackOrderPayload(payload: UnknownRecord): boolean {
  const meta = getMetadata(payload)
  const packId = (meta ? getProp(meta, "packId") : undefined) as string | undefined
  if (packId && packId in MINUTE_PACK_MAP) return true

  const productId = (getProp(payload, "productId") ??
    getProp(payload, "skuId") ??
    (meta ? getProp(meta, "productId") : undefined)) as string | undefined
  if (productId) {
    const tail = productId.split(/[_-]/).pop() ?? ""
    if (tail in MINUTE_PACK_MAP) return true
    for (const id of Object.keys(MINUTE_PACK_MAP) as PackId[]) {
      if (productId === `polar_pack_${id}` || productId === `razorpay_pack_${id}`) return true
    }
  }
  return false
}
