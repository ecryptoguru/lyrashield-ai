import { expect, test } from "@playwright/test"
import { getSystemPrisma } from "@lyrashield/db"
import {
  billingQuoteNotes,
  cancelRazorpayPaymentLink,
  cancelRazorpaySubscription,
} from "@lyrashield/billing"
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
  process.env.BILLING_STAGING_REGION === "inr" &&
  keyId.startsWith("rzp_test_") &&
  Boolean(process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET)
const plans = ["STARTER", "PRO", "TEAM"] as const
const intervals = ["monthly", "annual"] as const
const packs = [
  ["pack_100", 100, 150_000],
  ["pack_250", 250, 300_000],
  ["pack_500", 500, 500_000],
] as const

function razorpayPlanId(key: string): string {
  const id = (JSON.parse(process.env.RAZORPAY_PLAN_IDS ?? "{}") as Record<string, string>)[key]
  if (!id) throw new Error(`RAZORPAY_PLAN_IDS is missing ${key}`)
  return id
}

function signedQuoteNotes(
  kind: "pack" | "local",
  workspaceId: string,
  catalogKey: string,
  amountMinor: number
) {
  return billingQuoteNotes({
    provider: "razorpay",
    kind,
    workspaceId,
    catalogKey,
    amountMinor,
    currency: "INR",
  })
}

test.describe("Razorpay Test Mode billing proof", () => {
  test.skip(!enabled, "requires an isolated Razorpay Test Mode billing environment")
  test.describe.configure({ mode: "serial" })
  let actors: BillingActors
  const hostedSubscriptionIds: string[] = []
  const hostedPaymentLinkIds: string[] = []

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(120_000)
    actors = await provisionBillingActors(browser, String(testInfo.project.use.baseURL))
  })

  test.afterAll(async ({ browser: _browser }, testInfo) => {
    testInfo.setTimeout(120_000)
    const cleanupFailures: string[] = []
    let actorCleanupError: unknown
    try {
      for (const subscriptionId of hostedSubscriptionIds) {
        if (!(await cancelRazorpaySubscription(subscriptionId))) {
          cleanupFailures.push(subscriptionId)
        }
      }
      for (const paymentLinkId of hostedPaymentLinkIds) {
        if (!(await cancelRazorpayPaymentLink(paymentLinkId))) {
          cleanupFailures.push(paymentLinkId)
        }
      }
    } finally {
      try {
        await actors?.cleanup()
      } catch (error) {
        actorCleanupError = error
      }
    }
    const cleanupErrors = actorCleanupError ? [actorCleanupError] : []
    if (cleanupFailures.length > 0) {
      cleanupErrors.push(
        new Error(`Razorpay Test objects were not canceled: ${cleanupFailures.join(",")}`)
      )
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Razorpay Test cleanup failed")
    }
  })

  test("VIEWER cannot use billing-management routes", async () => {
    await expectViewerBillingDenied(actors.viewerRequest, actors.workspaceId)
  })

  for (const plan of plans) {
    for (const interval of intervals) {
      test(`${plan} ${interval} creates a Test Mode subscription`, async () => {
        const response = await actors.ownerRequest.post("/billing/checkout", {
          data: { workspaceId: actors.workspaceId, plan, interval },
        })
        await expect(response).toBeOK()
        const body = await response.json()
        expect(body.data.subscriptionId).toEqual(expect.any(String))
        hostedSubscriptionIds.push(body.data.subscriptionId as string)
        expect(body).toMatchObject({
          success: true,
          data: { provider: "razorpay", subscriptionId: expect.any(String), keyId },
        })
      })
    }
  }

  test("client region override remains rejected", async () => {
    const response = await actors.ownerRequest.post("/billing/checkout", {
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
            plan_id: razorpayPlanId("team_annual"),
            status: "active",
            current_start: now,
            current_end: now + 365 * 86_400,
            notes,
          },
        },
        payment: {
          entity: {
            id: `pay_subscription_${Date.now()}`,
            amount: 26_900_000,
            currency: "INR",
            notes,
          },
        },
      },
    }
    await expect(await postRazorpayWebhook(actors.ownerRequest, eventId, charged)).toBeOK()
    await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, eventId, charged), {
      billingAccount: () =>
        prisma.billingAccount.count({ where: { workspaceId: actors.workspaceId } }),
      subscriptionAudit: () =>
        prisma.auditLog.count({
          where: { workspaceId: actors.workspaceId, action: "billing.subscription_synced" },
        }),
      commission: () => prisma.commission.count(),
    })
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
              plan_id: razorpayPlanId("team_annual"),
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

  for (const [packId, minutes, amountMinor] of packs) {
    test(`${packId} hosted link and signed capture create no commission`, async () => {
      const checkout = await actors.ownerRequest.post("/api/billing/topup", {
        data: { workspaceId: actors.workspaceId, pack: packId },
      })
      await expect(checkout).toBeOK()
      const checkoutBody = await checkout.json()
      expect(checkoutBody.data.id).toEqual(expect.any(String))
      hostedPaymentLinkIds.push(checkoutBody.data.id as string)
      expect(checkoutBody).toMatchObject({
        success: true,
        data: { provider: "razorpay", url: expect.any(String), id: expect.any(String) },
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
              amount: amountMinor,
              currency: "INR",
              notes: {
                workspaceId: actors.workspaceId,
                packId,
                ...signedQuoteNotes("pack", actors.workspaceId, packId, amountMinor),
              },
            },
          },
        },
      }
      await expect(await postRazorpayWebhook(actors.ownerRequest, eventId, captured)).toBeOK()
      if (packId === "pack_100") {
        await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, eventId, captured), {
          minutePack: () =>
            prisma.minutePack.count({
              where: { workspaceId: actors.workspaceId, externalId: paymentId },
            }),
          commission: () => prisma.commission.count(),
        })
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
            notes: {
              workspaceId: actors.workspaceId,
              packId: "pack_100",
              ...signedQuoteNotes("pack", actors.workspaceId, "pack_100", 150_000),
            },
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
            amount_refunded: 1_500_00,
            currency: "INR",
            refund_status: "full",
            notes: { workspaceId: actors.workspaceId, packId: "pack_100" },
          },
        },
        refund: {
          entity: {
            id: refundId,
            payment_id: paymentId,
            amount: 1_500_00,
            currency: "INR",
            status: "processed",
          },
        },
      },
    }
    await expect(await postRazorpayWebhook(actors.ownerRequest, refundEventId, refund)).toBeOK()
    await replayOneHundred(() => postRazorpayWebhook(actors.ownerRequest, refundEventId, refund), {
      minutePack: () =>
        prisma.minutePack.count({
          where: { workspaceId: actors.workspaceId, externalId: paymentId },
        }),
      refundAudit: () =>
        prisma.auditLog.count({
          where: { workspaceId: actors.workspaceId, action: "billing.refund_reversed" },
        }),
    })
    await assertSingleProcessedEffect({
      provider: "razorpay",
      eventId: refundEventId,
      tracks: ["billing"],
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
      data: {},
    })
    await expect(checkout).toBeOK()
    expect(await checkout.json()).toMatchObject({ success: true, data: { provider: "razorpay" } })

    const paymentId = `pay_local_${Date.now()}`
    const eventId = `razorpay-local-${Date.now()}`
    const quoteWorkspaceId = `local-proof-${Date.now()}`
    const localNotes = {
      workspaceId: actors.workspaceId,
      productId: "individual_launch",
      quoteWorkspaceId,
      ...signedQuoteNotes("local", quoteWorkspaceId, "individual_launch", 1_990_000),
    }
    await expect(
      await postRazorpayWebhook(actors.ownerRequest, eventId, {
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment_link: {
            entity: { id: `plink_${Date.now()}`, notes: localNotes },
          },
          payment: {
            entity: {
              id: paymentId,
              amount: 19_900_00,
              currency: "INR",
              email: actors.ownerEmail,
              notes: localNotes,
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
