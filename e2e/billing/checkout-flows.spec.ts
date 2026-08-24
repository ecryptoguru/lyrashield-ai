import { expect, test } from "@playwright/test"
import { getSystemPrisma } from "@lyrashield/db"
import { expectViewerBillingDenied, provisionBillingActors, type BillingActors } from "./fixtures"
import { assertSingleProcessedEffect, postPolarWebhook, replayOneHundred } from "./webhook-helpers"

const enabled =
  process.env.POLAR_TEST_MODE === "1" &&
  process.env.POLAR_ENVIRONMENT === "sandbox" &&
  Boolean(process.env.POLAR_ACCESS_TOKEN && process.env.POLAR_WEBHOOK_SECRET)
const prisma = getSystemPrisma()
const plans = ["STARTER", "PRO", "TEAM"] as const
const intervals = ["monthly", "annual"] as const
const packs = [
  ["pack_100", 100, 1500],
  ["pack_250", 250, 3000],
  ["pack_500", 500, 5000],
] as const

function polarProductId(key: string): string {
  const id = (JSON.parse(process.env.POLAR_PRODUCT_IDS ?? "{}") as Record<string, string>)[key]
  if (!id) throw new Error(`POLAR_PRODUCT_IDS is missing ${key}`)
  return id
}

test.describe("Polar Sandbox billing proof", () => {
  test.skip(!enabled, "requires an isolated Polar Sandbox billing environment")
  test.describe.configure({ mode: "serial" })
  let actors: BillingActors
  let affiliateProgramId: string | null = null
  let affiliateId: string

  test.beforeAll(async ({ browser }, testInfo) => {
    actors = await provisionBillingActors(browser, String(testInfo.project.use.baseURL))
    const activeProgram = await prisma.affiliateProgram.findFirst({ where: { active: true } })
    if (!activeProgram) {
      affiliateProgramId = (
        await prisma.affiliateProgram.create({
          data: { slug: `billing-e2e-${Date.now()}`, active: true },
        })
      ).id
    }
    affiliateId = (
      await prisma.affiliate.create({
        data: {
          userId: actors.viewerUserId,
          status: "APPROVED",
          approvedAt: new Date(),
          acceptedTermsAt: new Date(),
          termsVersion: "billing-e2e",
        },
      })
    ).id
  })

  test.afterAll(async () => {
    try {
      await actors?.cleanup()
    } finally {
      if (affiliateProgramId) {
        await prisma.affiliateProgram.delete({ where: { id: affiliateProgramId } })
      }
    }
  })

  test("VIEWER cannot use billing-management routes", async () => {
    await expectViewerBillingDenied(actors.viewerRequest, actors.workspaceId)
  })

  for (const plan of plans) {
    for (const interval of intervals) {
      test(`${plan} ${interval} creates a hosted Sandbox checkout`, async () => {
        const response = await actors.ownerRequest.post("/billing/checkout", {
          data: { workspaceId: actors.workspaceId, plan, interval },
        })
        await expect(response).toBeOK()
        const body = await response.json()
        expect(body).toMatchObject({ success: true, data: { provider: "polar" } })
        expect(new URL(body.data.url).protocol).toBe("https:")
      })
    }
  }

  test("signed activation, 100 replays, and cancellation persist exactly once", async () => {
    const subscriptionId = `polar-sub-${Date.now()}`
    const activeEventId = `polar-active-${Date.now()}`
    const data = {
      id: subscriptionId,
      product_id: polarProductId("pro_monthly"),
      status: "active",
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      metadata: { workspaceId: actors.workspaceId, plan: "PRO", interval: "monthly" },
    }
    const active = { type: "subscription.active", data }
    await expect(await postPolarWebhook(actors.ownerRequest, activeEventId, active)).toBeOK()
    await replayOneHundred(() => postPolarWebhook(actors.ownerRequest, activeEventId, active), {
      billingAccount: () =>
        prisma.billingAccount.count({ where: { workspaceId: actors.workspaceId } }),
      subscriptionAudit: () =>
        prisma.auditLog.count({
          where: { workspaceId: actors.workspaceId, action: "billing.subscription_synced" },
        }),
    })
    await assertSingleProcessedEffect({
      provider: "polar",
      eventId: activeEventId,
      tracks: ["billing"],
    })
    expect(
      await prisma.billingAccount.findUnique({ where: { workspaceId: actors.workspaceId } })
    ).toMatchObject({ externalId: subscriptionId, currentPlan: "PRO", status: "active" })
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: actors.workspaceId, action: "billing.subscription_synced" },
      })
    ).toBeGreaterThan(0)

    const canceledEventId = `polar-canceled-${Date.now()}`
    await expect(
      await postPolarWebhook(actors.ownerRequest, canceledEventId, {
        type: "subscription.canceled",
        data: { ...data, status: "canceled", canceled_at: new Date().toISOString() },
      })
    ).toBeOK()
    await assertSingleProcessedEffect({
      provider: "polar",
      eventId: canceledEventId,
      tracks: ["billing"],
    })
    expect(
      await prisma.billingAccount.findUnique({ where: { workspaceId: actors.workspaceId } })
    ).toMatchObject({ status: "canceled" })
  })

  for (const [packId, minutes, amountMinor] of packs) {
    test(`${packId} checkout and signed credit create no commission`, async () => {
      const checkout = await actors.ownerRequest.post("/api/billing/topup", {
        data: { workspaceId: actors.workspaceId, pack: packId },
      })
      await expect(checkout).toBeOK()
      const before = await prisma.commission.count()
      const orderId = `polar-${packId}-${Date.now()}`
      const eventId = `polar-${packId}-event-${Date.now()}`
      const event = {
        type: "order.paid",
        data: {
          id: orderId,
          product_id: polarProductId(packId),
          currency: "USD",
          subtotal_amount: amountMinor,
          total_amount: amountMinor,
          discount_amount: 0,
          tax_amount: 0,
          net_amount: amountMinor,
          metadata: { workspaceId: actors.workspaceId, packId },
        },
      }
      await expect(await postPolarWebhook(actors.ownerRequest, eventId, event)).toBeOK()
      if (packId === "pack_100") {
        await replayOneHundred(() => postPolarWebhook(actors.ownerRequest, eventId, event), {
          minutePack: () =>
            prisma.minutePack.count({
              where: { workspaceId: actors.workspaceId, externalId: orderId },
            }),
          commission: () => prisma.commission.count(),
        })
      }
      await assertSingleProcessedEffect({ provider: "polar", eventId, tracks: ["billing"] })
      expect(
        await prisma.minutePack.findUnique({
          where: {
            workspaceId_externalId: { workspaceId: actors.workspaceId, externalId: orderId },
          },
        })
      ).toMatchObject({ workspaceId: actors.workspaceId, provider: "polar", minutes })
      expect(await prisma.commission.count()).toBe(before)
    })
  }

  test("affiliate-attributed Cloud payment is commissioned, then reversed by refund", async () => {
    const orderId = `polar-affiliate-${Date.now()}`
    const paidEventId = `polar-affiliate-paid-${Date.now()}`
    const event = {
      type: "order.paid",
      data: {
        id: orderId,
        product_id: polarProductId("pro_monthly"),
        customer_id: `customer-${Date.now()}`,
        customer_email: actors.ownerEmail,
        currency: "USD",
        subtotal_amount: 9900,
        total_amount: 9900,
        discount_amount: 0,
        tax_amount: 0,
        net_amount: 9900,
        metadata: {
          workspaceId: actors.workspaceId,
          plan: "PRO",
          planId: "PRO",
          interval: "monthly",
          subscriptionId: `polar-affiliate-sub-${Date.now()}`,
          isFirstPayment: true,
          affiliate_id: affiliateId,
        },
      },
    }
    await expect(await postPolarWebhook(actors.ownerRequest, paidEventId, event)).toBeOK()
    await replayOneHundred(() => postPolarWebhook(actors.ownerRequest, paidEventId, event), {
      conversion: () => prisma.conversion.count({ where: { externalId: orderId } }),
      commission: () => prisma.commission.count({ where: { affiliateId } }),
    })
    await assertSingleProcessedEffect({
      provider: "polar",
      eventId: paidEventId,
      tracks: ["billing", "affiliate"],
    })
    const commission = await prisma.commission.findFirstOrThrow({
      where: { affiliateId, conversion: { externalId: orderId } },
    })
    expect(commission.status).toBe("PENDING")

    const refundEventId = `polar-affiliate-refund-${Date.now()}`
    await expect(
      await postPolarWebhook(actors.ownerRequest, refundEventId, {
        type: "refund.created",
        data: {
          id: refundEventId,
          order_id: orderId,
          amount: 9900,
          currency: "USD",
          metadata: { workspaceId: actors.workspaceId },
        },
      })
    ).toBeOK()
    await assertSingleProcessedEffect({
      provider: "polar",
      eventId: refundEventId,
      tracks: ["billing", "affiliate"],
    })
    expect(await prisma.commission.findUnique({ where: { id: commission.id } })).toMatchObject({
      status: "REVERSED",
    })
    expect(
      await prisma.auditLog.count({
        where: { workspaceId: actors.workspaceId, action: "billing.refund_reversed" },
      })
    ).toBeGreaterThan(0)
  })

  test("Local individual_launch fulfills one signed license", async () => {
    test.skip(
      process.env.BILLING_E2E_LOCAL_MODE !== "1",
      "requires public Local Sandbox admission and test email delivery"
    )
    const localProducts = JSON.parse(process.env.POLAR_LOCAL_PRODUCT_IDS ?? "{}") as Record<
      string,
      string
    >
    const providerProductId = localProducts.individual_launch
    expect(providerProductId).toBeTruthy()
    const checkout = await actors.ownerRequest.post("/api/billing/local-checkout", { data: {} })
    await expect(checkout).toBeOK()

    const orderId = `polar-local-${Date.now()}`
    const eventId = `polar-local-event-${Date.now()}`
    await expect(
      await postPolarWebhook(actors.ownerRequest, eventId, {
        type: "order.paid",
        data: {
          id: orderId,
          product_id: providerProductId,
          seats: 1,
          customer_email: actors.ownerEmail,
          currency: "USD",
          subtotal_amount: 19900,
          total_amount: 19900,
          discount_amount: 0,
          tax_amount: 0,
          net_amount: 19900,
          metadata: { workspaceId: actors.workspaceId, productId: "individual_launch" },
        },
      })
    ).toBeOK()
    await assertSingleProcessedEffect({
      provider: "polar",
      eventId,
      tracks: ["billing", "license", "affiliate"],
    })
    const key = await prisma.licenseKey.findFirstOrThrow({
      where: { issuedByProvider: `polar:${orderId}` },
      include: { license: true },
    })
    expect(key.fulfillmentStatus).toBe("DELIVERED")
    expect(key.license).toMatchObject({
      workspaceId: actors.workspaceId,
      ownerEmail: actors.ownerEmail,
      sku: "individual_launch",
    })
    expect(key.license.signature).not.toBe("pending")
    await prisma.license.delete({ where: { id: key.licenseId } })
  })
})
