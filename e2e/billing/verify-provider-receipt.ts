import { getSystemPrisma } from "@lyrashield/db"

const provider = process.env.BILLING_RECEIPT_PROVIDER
const eventId = process.env.BILLING_RECEIPT_EVENT_ID
const workspaceId = process.env.BILLING_RECEIPT_WORKSPACE_ID
const kind = process.env.BILLING_RECEIPT_KIND
const objectId = process.env.BILLING_RECEIPT_OBJECT_ID

if (
  !["polar", "razorpay"].includes(provider ?? "") ||
  !eventId ||
  !workspaceId ||
  !["subscription", "pack"].includes(kind ?? "") ||
  !objectId ||
  !/^[A-Za-z0-9_:-]{1,191}$/.test(eventId) ||
  !/^[A-Za-z0-9_:-]{1,191}$/.test(objectId)
) {
  throw new Error(
    "Provider receipt verifier requires valid provider, event, workspace, kind, and object IDs"
  )
}

const prisma = getSystemPrisma()
const event = await prisma.webhookEvent.findUnique({
  where: { provider_externalId: { provider, externalId: eventId } },
  include: { tracks: { select: { track: true, status: true, attempts: true } } },
})
if (!event || event.workspaceId !== workspaceId || !event.processed) {
  throw new Error("Provider receipt did not produce one processed workspace-bound webhook event")
}
if (!event.tracks.some((track) => track.track === "billing" && track.status === "succeeded")) {
  throw new Error("Provider receipt billing track is incomplete")
}
if (event.tracks.some((track) => track.attempts > 1 && track.status !== "succeeded")) {
  throw new Error("Provider receipt has an unresolved replay or retry")
}

if (kind === "subscription") {
  const account = await prisma.billingAccount.findUnique({ where: { workspaceId } })
  if (
    !account ||
    account.provider !== provider ||
    account.externalId !== objectId ||
    account.currentPlan !== process.env.BILLING_RECEIPT_PLAN ||
    account.interval !== process.env.BILLING_RECEIPT_INTERVAL ||
    account.status !== process.env.BILLING_RECEIPT_STATUS
  ) {
    throw new Error("Provider receipt subscription state does not match expected provider result")
  }
} else {
  const minutes = Number.parseInt(process.env.BILLING_RECEIPT_MINUTES ?? "", 10)
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error("Provider receipt pack verification requires positive expected minutes")
  }
  const pack = await prisma.minutePack.findUnique({
    where: { workspaceId_externalId: { workspaceId, externalId: objectId } },
  })
  if (!pack || pack.provider !== provider || pack.minutes !== minutes) {
    throw new Error("Provider receipt minute pack does not match expected provider result")
  }
  const commissions = await prisma.commission.count({ where: { workspaceId } })
  if (commissions !== 0) throw new Error("Minute packs must not create affiliate commission")
}

console.log(
  `Provider-delivered ${provider} ${kind} receipt verified without identifiers or payloads.`
)
