import { createHmac } from "node:crypto"
import { expect, test } from "@playwright/test"
import { prisma } from "@lyrashield/db"

/**
 * Polar Sandbox checkout and signed-webhook receipt proof.
 *
 * Requires a disposable verified OWNER session and workspace. It creates
 * hosted Sandbox checkout objects but never submits payment details. Signed
 * webhook fixtures prove application effects against the disposable database.
 */
const workspaceId = process.env.BILLING_E2E_WORKSPACE_ID?.trim() ?? ""
const storageState = process.env.BILLING_E2E_STORAGE_STATE?.trim() ?? ""
const webhookSecret = process.env.POLAR_WEBHOOK_SECRET?.trim() ?? ""
const enabled =
  process.env.POLAR_TEST_MODE === "1" &&
  process.env.POLAR_ENVIRONMENT === "sandbox" &&
  Boolean(workspaceId && storageState && webhookSecret)

if (storageState) test.use({ storageState })

function polarHeaders(id: string, body: string): Record<string, string> {
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("POLAR_WEBHOOK_SECRET must use the whsec_ format")
  }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64")
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  }
}

async function postPolarWebhook(
  request: import("@playwright/test").APIRequestContext,
  id: string,
  event: Record<string, unknown>
) {
  const body = JSON.stringify(event)
  return request.post("/billing/webhook", { data: body, headers: polarHeaders(id, body) })
}

test.describe("Checkout flows (Polar Sandbox)", () => {
  test.skip(
    !enabled,
    "requires Polar Sandbox plus BILLING_E2E_WORKSPACE_ID and BILLING_E2E_STORAGE_STATE"
  )

  test("monthly checkout and signed active event grant the monthly pool", async ({ request }) => {
    const checkoutResponse = await request.post("/billing/checkout", {
      data: { workspaceId, plan: "STARTER", interval: "monthly" },
    })
    await expect(checkoutResponse).toBeOK()
    await expect(checkoutResponse.json()).resolves.toMatchObject({
      success: true,
      data: { provider: "polar" },
    })

    const receipt = await postPolarWebhook(request, `polar-monthly-${Date.now()}`, {
      type: "subscription.active",
      data: {
        id: `sub-monthly-${Date.now()}`,
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        metadata: { workspaceId, plan: "STARTER", interval: "monthly" },
      },
    })
    await expect(receipt).toBeOK()

    const usageResponse = await request.get(`/api/billing/usage?workspaceId=${workspaceId}`)
    await expect(usageResponse).toBeOK()
    await expect(usageResponse.json()).resolves.toMatchObject({
      data: { plan: "STARTER", usage: { poolMinutes: 300 } },
    })
  })

  test("annual checkout grants one monthly PRO pool, not twelve", async ({ request }) => {
    const checkoutResponse = await request.post("/billing/checkout", {
      data: { workspaceId, plan: "PRO", interval: "annual" },
    })
    await expect(checkoutResponse).toBeOK()

    const receipt = await postPolarWebhook(request, `polar-annual-${Date.now()}`, {
      type: "subscription.active",
      data: {
        id: `sub-annual-${Date.now()}`,
        status: "active",
        current_period_start: new Date(Date.now() + 1_000).toISOString(),
        current_period_end: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        metadata: { workspaceId, plan: "PRO", interval: "annual" },
      },
    })
    await expect(receipt).toBeOK()

    const usageResponse = await request.get(`/api/billing/usage?workspaceId=${workspaceId}`)
    const usage = await usageResponse.json()
    expect(usage.data.usage.poolMinutes).toBe(1200)
  })

  test("minute pack, refund, and 100 replays produce one durable effect", async ({ request }) => {
    const topupResponse = await request.post("/api/billing/topup", {
      data: { workspaceId, pack: "pack_100" },
    })
    await expect(topupResponse).toBeOK()

    const orderId = `order-pack-${Date.now()}`
    const eventId = `polar-pack-${Date.now()}`
    const paidEvent = {
      type: "order.paid",
      data: { id: orderId, metadata: { workspaceId, packId: "pack_100" } },
    }
    await expect(await postPolarWebhook(request, eventId, paidEvent)).toBeOK()
    const replays = await Promise.all(
      Array.from({ length: 100 }, () => postPolarWebhook(request, eventId, paidEvent))
    )
    for (const replay of replays) await expect(replay).toBeOK()

    expect(
      await prisma.webhookEvent.count({
        where: { provider: "polar", externalId: eventId, processed: true },
      })
    ).toBe(1)
    expect(await prisma.minutePack.count({ where: { workspaceId, externalId: orderId } })).toBe(1)

    const refundId = `polar-refund-${Date.now()}`
    await expect(
      await postPolarWebhook(request, refundId, {
        type: "refund.created",
        data: { id: refundId, order_id: orderId, metadata: { workspaceId } },
      })
    ).toBeOK()
    await expect
      .poll(() =>
        prisma.minutePack.findFirst({
          where: { workspaceId, externalId: orderId },
          select: { remainingMinutes: true },
        })
      )
      .toMatchObject({ remainingMinutes: 0 })
  })
})
