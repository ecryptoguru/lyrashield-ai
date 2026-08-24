import { expect, test } from "@playwright/test"
import { getSystemPrisma } from "@lyrashield/db"
import { cancelRazorpaySubscription } from "@lyrashield/billing"
import { expectViewerBillingDenied, provisionBillingActors, type BillingActors } from "./fixtures"
import {
  assertSingleProcessedEffect,
  postRazorpayWebhook,
  replayOneHundred,
} from "./webhook-helpers"

const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? ""
const prisma = getSystemPrisma()
const enabled =
  process.env.RAZORPAY_TEST_MODE === "1" &&
  keyId.startsWith("rzp_test_") &&
  Boolean(process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET)
const indiaHeaders = { "x-forwarded-for": "192.0.2.44", "cf-ipcountry": "IN" }
const plans = ["STARTER", "PRO", "TEAM"] as const
const intervals = ["monthly", "annual"] as const
const packs = [
  ["pack_100", 100],
  ["pack_250", 250],
  ["pack_500", 500],
] as const

test.describe("Razorpay Test Mode billing proof", () => {
  test.skip(!enabled, "requires an isolated Razorpay Test Mode billing environment")
  test.describe.configure({ mode: "serial" })
  let actors: BillingActors
  const hostedSubscriptionIds: string[] = []

  test.beforeAll(async ({ browser }, testInfo) => {
    actors = await provisionBillingActors(browser, String(testInfo.project.use.baseURL))
  })

  test.afterAll(async () => {
    const cleanupFailures: string[] = []
    for (const subscriptionId of hostedSubscriptionIds) {
      if (!(await cancelRazorpaySubscription(subscriptionId))) {
        cleanupFailures.push(subscriptionId)
      }
    }
    await actors?.cleanup()
    if (cleanupFailures.length > 0) {
      throw new Error(`Razorpay Test subscriptions were not canceled: ${cleanupFailures.join(",")}`)
    }
  })

  test("VIEWER cannot use billing-management routes", async () => {
    await expectViewerBillingDenied(actors.viewerRequest, actors.workspaceId)
  })

  for (const plan of plans) {
    for (const interval of intervals) {
      test(`${plan} ${interval} creates a Test Mode subscription`, async () => {
        const response = await actors.ownerRequest.post("/billing/checkout", {
          headers: indiaHeaders,
          data: { workspaceId: actors.workspaceId, plan, interval },
        })
        await expect(response).toBeOK()
        const body = await response.json()
        expect(body).toMatchObject({
          success: true,
          data: { provider: "razorpay", subscriptionId: expect.any(String), keyId },
        })
        hostedSubscriptionIds.push(body.data.subscriptionId as string)
      })
    }
  }

  test("client region override remains rejected", async () => {
    const response = await actors.ownerRequest.post("/billing/checkout", {
      headers: indiaHeaders,
      data: {
        workspaceId: actors.workspaceId,
        plan: "STARTER",
        interval: "monthly",
        region: "inr",
      },
    })
    expect(response.status()).toBe(400)
  })

  test("signed charge, 100 replays, and cancellation persist exactly once", async () => {
    const now = Math.floor(Date.now() / 1000)
    const subscriptionId = `sub_test_${Date.now()}`
    const eventId = `razorpay-charge-${Date.now()}`
    const notes = { workspaceId: actors.workspaceId, plan: "TEAM", interval: "annual" }
    const charged = {
      event: "subscription.charged",
      created_at: now,
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            status: "active",
            current_start: now,
            current_end: now + 365 * 86_400,
            notes,
          },
        },
        payment: {
          entity: {
            id: `pay_subscription_${Date.now()}`,
            amount: 59_900_00,
            currency: "INR",
            notes,
          },
        },
      },
    }
    await expect(await postRazorpayWebhook(actors.ownerRequest, eventId, charged)).toBeOK()
    await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, eventId, charged))
    await assertSingleProcessedEffect({
      provider: "razorpay",
      eventId,
      tracks: ["billing", "affiliate"],
    })
    expect(
      await prisma.billingAccount.findUnique({ where: { workspaceId: actors.workspaceId } })
    ).toMatchObject({ externalId: subscriptionId, currentPlan: "TEAM", status: "active" })
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: actors.workspaceId, action: "billing.subscription_synced" },
      })
    ).toBeGreaterThan(0)

    const canceledId = `razorpay-canceled-${Date.now()}`
    await expect(
      await postRazorpayWebhook(actors.ownerRequest, canceledId, {
        event: "subscription.cancelled",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          subscription: {
            entity: {
              id: subscriptionId,
              status: "cancelled",
              ended_at: Math.floor(Date.now() / 1000),
              notes,
            },
          },
        },
      })
    ).toBeOK()
    await assertSingleProcessedEffect({
      provider: "razorpay",
      eventId: canceledId,
      tracks: ["billing"],
    })
    expect(
      await prisma.billingAccount.findUnique({ where: { workspaceId: actors.workspaceId } })
    ).toMatchObject({ status: "canceled" })
  })

  for (const [packId, minutes] of packs) {
    test(`${packId} hosted link and signed capture create no commission`, async () => {
      const checkout = await actors.ownerRequest.post("/api/billing/topup", {
        headers: indiaHeaders,
        data: { workspaceId: actors.workspaceId, pack: packId },
      })
      await expect(checkout).toBeOK()
      expect(await checkout.json()).toMatchObject({
        success: true,
        data: { provider: "razorpay", url: expect.any(String) },
      })

      const before = await prisma.commission.count()
      const paymentId = `pay_${packId}_${Date.now()}`
      const eventId = `razorpay-${packId}-${Date.now()}`
      const captured = {
        event: "payment.captured",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: paymentId,
              amount: 1_500_00,
              currency: "INR",
              notes: { workspaceId: actors.workspaceId, packId },
            },
          },
        },
      }
      await expect(await postRazorpayWebhook(actors.ownerRequest, eventId, captured)).toBeOK()
      if (packId === "pack_100") {
        await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, eventId, captured))
      }
      await assertSingleProcessedEffect({ provider: "razorpay", eventId, tracks: ["billing"] })
      expect(
        await prisma.minutePack.findUnique({
          where: {
            workspaceId_externalId: { workspaceId: actors.workspaceId, externalId: paymentId },
          },
        })
      ).toMatchObject({ workspaceId: actors.workspaceId, provider: "razorpay", minutes })
      expect(await prisma.commission.count()).toBe(before)
    })
  }

  test("signed refund reverses a pack and remains idempotent", async () => {
    const paymentId = `pay_refund_${Date.now()}`
    const capturedId = `razorpay-refund-source-${Date.now()}`
    const captured = {
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 1_500_00,
            currency: "INR",
            notes: { workspaceId: actors.workspaceId, packId: "pack_100" },
          },
        },
      },
    }
    await expect(await postRazorpayWebhook(actors.ownerRequest, capturedId, captured)).toBeOK()

    const refundId = `refund_test_${Date.now()}`
    const refundEventId = `razorpay-refund-${Date.now()}`
    const refund = {
      event: "refund.created",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 1_500_00,
            currency: "INR",
            notes: { workspaceId: actors.workspaceId },
          },
        },
        refund: { entity: { id: refundId, payment_id: paymentId, amount: 1_500_00 } },
      },
    }
    await expect(await postRazorpayWebhook(actors.ownerRequest, refundEventId, refund)).toBeOK()
    await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, refundEventId, refund))
    await assertSingleProcessedEffect({
      provider: "razorpay",
      eventId: refundEventId,
      tracks: ["billing", "affiliate"],
    })
    expect(
      await prisma.minutePack.findUnique({
        where: {
          workspaceId_externalId: { workspaceId: actors.workspaceId, externalId: paymentId },
        },
      })
    ).toMatchObject({ remainingMinutes: 0 })
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: actors.workspaceId, action: "billing.refund_reversed" },
      })
    ).toBeGreaterThan(0)
  })

  test("Local individual_launch fulfills one signed license", async () => {
    test.skip(
      process.env.BILLING_E2E_LOCAL_MODE !== "1",
      "requires public Local Test admission and test email delivery"
    )
    const checkout = await actors.ownerRequest.post("/api/billing/local-checkout", {
      headers: indiaHeaders,
      data: {},
    })
    await expect(checkout).toBeOK()
    expect(await checkout.json()).toMatchObject({ success: true, data: { provider: "razorpay" } })

    const paymentId = `pay_local_${Date.now()}`
    const eventId = `razorpay-local-${Date.now()}`
    await expect(
      await postRazorpayWebhook(actors.ownerRequest, eventId, {
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment_link: {
            entity: { id: `plink_${Date.now()}`, notes: { productId: "individual_launch" } },
          },
          payment: {
            entity: {
              id: paymentId,
              amount: 19_900_00,
              currency: "INR",
              email: actors.ownerEmail,
              notes: { workspaceId: actors.workspaceId, productId: "individual_launch" },
            },
          },
        },
      })
    ).toBeOK()
    await assertSingleProcessedEffect({
      provider: "razorpay",
      eventId,
      tracks: ["billing", "license", "affiliate"],
    })
    const key = await prisma.licenseKey.findFirstOrThrow({
      where: { issuedByProvider: `razorpay:${paymentId}` },
      include: { license: true },
    })
    expect(key.fulfillmentStatus).toBe("DELIVERED")
    expect(key.license).toMatchObject({ sku: "individual_launch", ownerEmail: actors.ownerEmail })
    expect(key.license.signature).not.toBe("pending")
    await prisma.license.delete({ where: { id: key.licenseId } })
  })
})
