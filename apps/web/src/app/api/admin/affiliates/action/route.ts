import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { setupReserve } from "@lyrashield/affiliate"

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    affiliateId: z.string().min(1),
  }),
  z.object({
    action: z.literal("reject"),
    affiliateId: z.string().min(1),
  }),
  z.object({
    action: z.literal("suspend"),
    affiliateId: z.string().min(1),
  }),
  z.object({
    action: z.literal("approvePayout"),
    payoutId: z.string().min(1),
  }),
  z.object({
    action: z.literal("tierOverride"),
    affiliateId: z.string().min(1),
    baseRateBps: z.number().int().min(0).max(10000).optional(),
    tierRateBps: z.number().int().min(0).max(10000).optional(),
  }),
])

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    )
  }

  const workspaceId = await getCachedWorkspaceId(session.userId)
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "No workspace" },
      { status: 403 }
    )
  }

  // Check admin permissions
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: session.userId },
    select: { role: true },
  })

  if (!membership || !hasPermission(membership.role, PERMISSIONS.affiliate.admin)) {
    return NextResponse.json(
      { success: false, error: "Insufficient permissions" },
      { status: 403 }
    )
  }

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request" },
      { status: 400 }
    )
  }

  const data = parsed.data

  if (data.action === "approve") {
    const affiliate = await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
      },
    })

    // Set up new-affiliate reserve
    await setupReserve(affiliate.id)

    // Generate promo code if not set
    if (!affiliate.promoCode) {
      const code = `LYRA${affiliate.id.slice(-6).toUpperCase()}`
      await prisma.affiliate.update({
        where: { id: affiliate.id },
        data: { promoCode: code },
      })
    }

    // Generate primary link if none exists
    const existingLink = await prisma.affiliateLink.findFirst({
      where: { affiliateId: affiliate.id },
    })

    if (!existingLink) {
      const { randomBytes } = await import("node:crypto")
      const linkCode = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase()
      await prisma.affiliateLink.create({
        data: {
          affiliateId: affiliate.id,
          code: linkCode,
          campaign: "primary",
        },
      })
    }

    logger.info("Affiliate approved", { affiliateId: data.affiliateId })
  } else if (data.action === "reject") {
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: { status: "REJECTED" },
    })
    logger.info("Affiliate rejected", { affiliateId: data.affiliateId })
  } else if (data.action === "suspend") {
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: { status: "SUSPENDED" },
    })
    logger.info("Affiliate suspended", { affiliateId: data.affiliateId })
  } else if (data.action === "approvePayout") {
    // C-M05: Guard — only approve PENDING/PROCESSING payouts with RESERVED commissions.
    // Prevents double-pay by approving a FAILED payout whose commissions were re-withdrawn.
    const payout = await prisma.payout.findUnique({
      where: { id: data.payoutId },
      select: { id: true, status: true },
    })

    if (!payout) {
      return NextResponse.json(
        { success: false, error: "Payout not found" },
        { status: 404 }
      )
    }

    if (payout.status !== "PENDING" && payout.status !== "PROCESSING") {
      return NextResponse.json(
        { success: false, error: `Payout is ${payout.status}, not PENDING/PROCESSING` },
        { status: 409 }
      )
    }

    // Verify commissions are still RESERVED (not already PAID or released)
    const items = await prisma.payoutItem.findMany({
      where: { payoutId: data.payoutId },
      select: { commissionId: true },
    })

    if (items.length === 0) {
      return NextResponse.json(
        { success: false, error: "Payout has no items" },
        { status: 409 }
      )
    }

    const commissions = await prisma.commission.findMany({
      where: { id: { in: items.map((i) => i.commissionId) } },
      select: { id: true, status: true },
    })

    const allReserved = commissions.every((c) => c.status === "RESERVED")
    if (!allReserved) {
      return NextResponse.json(
        { success: false, error: "Payout commissions are not all RESERVED" },
        { status: 409 }
      )
    }

    await prisma.payout.update({
      where: { id: data.payoutId },
      data: {
        status: "PAID",
        paidAt: new Date(),
      },
    })

    // Mark commissions as PAID
    await prisma.commission.updateMany({
      where: { id: { in: items.map((i) => i.commissionId) } },
      data: { status: "PAID" },
    })

    logger.info("Payout approved", { payoutId: data.payoutId, adminUserId: session.userId })
  } else if (data.action === "tierOverride") {
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: {
        ...(data.baseRateBps !== undefined && { baseRateBps: data.baseRateBps }),
        ...(data.tierRateBps !== undefined && { tierRateBps: data.tierRateBps }),
      },
    })
    logger.info("Affiliate tier overridden", {
      affiliateId: data.affiliateId,
      baseRateBps: data.baseRateBps,
      tierRateBps: data.tierRateBps,
    })
  }

  return NextResponse.json({ success: true })
}
