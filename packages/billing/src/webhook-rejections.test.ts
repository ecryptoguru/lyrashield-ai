import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  webhookEvent: { findUnique: vi.fn() },
  webhookEventRejection: { create: vi.fn() },
}))

vi.mock("@lyrashield/db", () => ({
  // The system role owns this global table; the tenant runtime role has no
  // access (enforced by migration RLS).
  getSystemPrisma: () => db,
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { recordWebhookRejection, WEBHOOK_REJECTION_REASONS } from "./webhook-rejections"

const input = {
  provider: "razorpay" as const,
  externalId: "9f".repeat(32),
  identitySource: "derived" as const,
  eventType: "payment.captured",
  reasonCode: WEBHOOK_REJECTION_REASONS.catalogEvidenceMismatch,
}

beforeEach(() => {
  vi.clearAllMocks()
  db.webhookEvent.findUnique.mockResolvedValue(null)
  db.webhookEventRejection.create.mockResolvedValue({ id: "rej_1" })
})

describe("recordWebhookRejection", () => {
  it("persists one bounded receipt — identifiers and reason code only", async () => {
    await expect(recordWebhookRejection(input)).resolves.toBe("recorded")

    expect(db.webhookEventRejection.create).toHaveBeenCalledTimes(1)
    const data = db.webhookEventRejection.create.mock.calls[0]![0].data
    // Bounded fields only: no payload, emails, secrets, or tenant binding.
    expect(Object.keys(data).sort()).toEqual(
      ["eventType", "externalId", "identitySource", "provider", "reasonCode"].sort()
    )
    expect(data).toMatchObject({
      provider: "razorpay",
      externalId: input.externalId,
      eventType: "payment.captured",
      reasonCode: "catalog_evidence_mismatch",
    })
  })

  it("dedupes a rejected replay without overwriting the first observation", async () => {
    db.webhookEventRejection.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    )
    await expect(recordWebhookRejection(input)).resolves.toBe("duplicate")
  })

  it("never overlays an accepted receipt for the same identity", async () => {
    db.webhookEvent.findUnique.mockResolvedValue({ id: "evt_accepted" })
    await expect(recordWebhookRejection(input)).resolves.toBe("accepted_receipt_exists")
    expect(db.webhookEventRejection.create).not.toHaveBeenCalled()
  })

  it("propagates storage failure so callers answer a retriable 5xx", async () => {
    db.webhookEventRejection.create.mockRejectedValue(new Error("connection lost"))
    await expect(recordWebhookRejection(input)).rejects.toThrow("connection lost")
  })
})
