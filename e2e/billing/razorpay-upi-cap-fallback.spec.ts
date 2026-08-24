import { createHmac } from "node:crypto"
import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

/**
 * Razorpay Test Mode checkout contract.
 *
 * Payment-method availability and mandate limits are provider-owned UI state.
 * This suite proves LyraShield creates Test Mode subscriptions without a
 * client region override. Brave receipts remain required for the exact methods
 * Razorpay presents for each price.
 */
const workspaceId = process.env.BILLING_E2E_WORKSPACE_ID?.trim() ?? ""
const storageState = process.env.BILLING_E2E_STORAGE_STATE?.trim() ?? ""
const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? ""
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? ""
const enabled =
  process.env.RAZORPAY_TEST_MODE === "1" &&
  keyId.startsWith("rzp_test_") &&
  Boolean(workspaceId && storageState && webhookSecret)

if (storageState) test.use({ storageState })

async function postRazorpayWebhook(
  request: import("@playwright/test").APIRequestContext,
  eventId: string,
  event: Record<string, unknown>
) {
  const body = JSON.stringify(event)
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex")
  return request.post("/billing/webhook", {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature": signature,
    },
  })
}

test.describe("Razorpay Test Mode checkout contract", () => {
  test.skip(
    !enabled,
    "requires rzp_test_ credentials plus BILLING_E2E_WORKSPACE_ID and BILLING_E2E_STORAGE_STATE"
  )

  for (const [plan, interval] of [
    ["STARTER", "monthly"],
    ["PRO", "annual"],
    ["TEAM", "monthly"],
    ["TEAM", "annual"],
  ] as const) {
    test(`${plan} ${interval} creates a Razorpay Test Mode subscription`, async ({ request }) => {
      const response = await request.post("/billing/checkout", {
        headers: { "x-forwarded-for": "192.0.2.44", "cf-ipcountry": "IN" },
        data: { workspaceId, plan, interval },
      })
      await expect(response).toBeOK()
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: {
          provider: "razorpay",
          subscriptionId: expect.any(String),
          keyId,
        },
      })
    })
  }

  test("rejects the removed client region override", async ({ request }) => {
    const response = await request.post("/billing/checkout", {
      data: { workspaceId, plan: "STARTER", interval: "monthly", region: "inr" },
    })
    expect(response.status()).toBe(400)
  })

  test("signed pack, 100 replays, and refund produce one durable effect", async ({ request }) => {
    const paymentId = `pay_test_${Date.now()}`
    const eventId = `razorpay-pack-${Date.now()}`
    const captured = {
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 1_500_00,
            currency: "INR",
            notes: { workspaceId, packId: "pack_100" },
          },
        },
      },
    }
    await expect(await postRazorpayWebhook(request, eventId, captured)).toBeOK()
    const replays = await Promise.all(
      Array.from({ length: 100 }, () => postRazorpayWebhook(request, eventId, captured))
    )
    for (const replay of replays) await expect(replay).toBeOK()

    expect(
      await prisma.webhookEvent.count({
        where: { provider: "razorpay", externalId: eventId, processed: true },
      })
    ).toBe(1)
    expect(await prisma.minutePack.count({ where: { workspaceId, externalId: paymentId } })).toBe(1)

    const refundId = `razorpay-refund-${Date.now()}`
    await expect(
      await postRazorpayWebhook(request, refundId, {
        event: "refund.created",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: paymentId,
              amount: 1_500_00,
              currency: "INR",
              notes: { workspaceId },
            },
          },
          refund: { entity: { id: refundId, payment_id: paymentId } },
        },
      })
    ).toBeOK()
    await expect
      .poll(() =>
        prisma.minutePack.findFirst({
          where: { workspaceId, externalId: paymentId },
          select: { remainingMinutes: true },
        })
      )
      .toMatchObject({ remainingMinutes: 0 })
  })
})
