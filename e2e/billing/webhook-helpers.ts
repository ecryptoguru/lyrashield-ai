import { createHmac } from "node:crypto"
import { expect, type APIRequestContext } from "@playwright/test"
import { getSystemPrisma } from "@lyrashield/db"

const prisma = getSystemPrisma()

export function requirePolarWebhookSecret(): string {
  const secret = process.env.POLAR_WEBHOOK_SECRET?.trim() ?? ""
  if (!secret.startsWith("whsec_")) {
    throw new Error("POLAR_WEBHOOK_SECRET must use the whsec_ format")
  }
  return secret
}

export async function postPolarWebhook(
  request: APIRequestContext,
  id: string,
  event: Record<string, unknown>
) {
  const body = JSON.stringify(event)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(requirePolarWebhookSecret().slice("whsec_".length), "base64")
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
  return request.post("/billing/webhook", {
    data: body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  })
}

export async function postRazorpayWebhook(
  request: APIRequestContext,
  id: string,
  event: Record<string, unknown>
) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? ""
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is required")
  const body = JSON.stringify(event)
  const signature = createHmac("sha256", secret).update(body).digest("hex")
  return request.post("/billing/webhook", {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": id,
      "x-razorpay-signature": signature,
    },
  })
}

export async function assertSingleProcessedEffect(params: {
  provider: "polar" | "razorpay"
  eventId: string
  tracks: string[]
}): Promise<void> {
  const event = await prisma.webhookEvent.findUniqueOrThrow({
    where: {
      provider_externalId: { provider: params.provider, externalId: params.eventId },
    },
    include: { tracks: true },
  })
  expect(event.processed).toBe(true)
  expect(event.tracks.map((track) => track.track).sort()).toEqual([...params.tracks].sort())
  expect(event.tracks.every((track) => track.status === "succeeded")).toBe(true)
}

export async function replayOneHundred(
  post: () => Promise<Awaited<ReturnType<APIRequestContext["post"]>>>
): Promise<void> {
  const responses = await Promise.all(Array.from({ length: 100 }, post))
  for (const response of responses) await expect(response).toBeOK()
}
