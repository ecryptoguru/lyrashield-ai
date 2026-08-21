import { NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { isPlatformOperator } from "@lyrashield/auth/server"
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

/**
 * Write an audit row for this route through the extended Prisma client.
 * AuditLog.workspaceId is a hard FK to Workspace — global affiliate
 * administration is not workspace-scoped, so the row attaches to the actor's
 * active workspace when one exists and is skipped otherwise (mirrors the
 * license renew route's conditional workspaceId handling).
 */
async function writeAffiliateAudit(
  actorUserId: string,
  data: { action: string; resourceType: string; resourceId?: string; metadata?: object }
) {
  const workspaceId = await getCachedWorkspaceId(actorUserId).catch(() => null)
  if (!workspaceId) return
  await prisma.auditLog
    .create({
      data: {
        workspaceId,
        actorUserId,
        ...data,
      },
    })
    .catch(() => {})
}

export async function POST(request: Request) {
  const session = await getCachedSession()
  if (!session) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 })
  }

  // Global affiliate administration is platform-operator authority. It never
  // derives from workspace membership or tenant roles, and does not require
  // the operator to belong to any workspace.
  if (!(await isPlatformOperator(session.userId))) {
    // Audit the denied mutation attempt (best-effort; requires a workspace
    // context for the AuditLog FK).
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.admin_denied",
      resourceType: "affiliate_admin_action",
    })
    logger.warn("Affiliate admin action denied — not a platform operator", {
      userId: session.userId,
    })
    return NextResponse.json({ success: false, error: "Insufficient permissions" }, { status: 403 })
  }

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 })
  }

  const data = parsed.data

  if (data.action === "approve") {
    // C-L10: Approval is gated on the affiliate having accepted the binding
    // program terms. An application without acceptedTermsAt cannot be approved
    // (it should never happen since the apply route requires acceptTerms, but
    // this guards against pre-terms-acceptance rows and any path that bypasses
    // the form).
    const existingAffiliate = await prisma.affiliate.findUnique({
      where: { id: data.affiliateId },
      select: { acceptedTermsAt: true, termsVersion: true },
    })
    if (!existingAffiliate?.acceptedTermsAt) {
      return NextResponse.json(
        {
          success: false,
          error: "Affiliate has not accepted the program terms — cannot approve",
        },
        { status: 400 }
      )
    }

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
    // C-L03: Use random bytes instead of affiliate ID suffix for unpredictability
    if (!affiliate.promoCode) {
      const { randomBytes } = await import("node:crypto")
      const code = `LYRA-${randomBytes(4).toString("base64url").slice(0, 6).toUpperCase()}`
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

    // C-M06: Write persistent audit log with admin userId
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.approved",
      resourceType: "affiliate",
      resourceId: data.affiliateId,
      metadata: { affiliateId: data.affiliateId },
    })

    logger.info("Affiliate approved", {
      affiliateId: data.affiliateId,
      adminUserId: session.userId,
    })
  } else if (data.action === "reject") {
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: { status: "REJECTED" },
    })

    // C-M06: Audit log
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.rejected",
      resourceType: "affiliate",
      resourceId: data.affiliateId,
      metadata: { affiliateId: data.affiliateId },
    })

    logger.info("Affiliate rejected", {
      affiliateId: data.affiliateId,
      adminUserId: session.userId,
    })
  } else if (data.action === "suspend") {
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: { status: "SUSPENDED" },
    })

    // C-M06: Audit log
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.suspended",
      resourceType: "affiliate",
      resourceId: data.affiliateId,
      metadata: { affiliateId: data.affiliateId },
    })

    logger.info("Affiliate suspended", {
      affiliateId: data.affiliateId,
      adminUserId: session.userId,
    })
  } else if (data.action === "approvePayout") {
    // C-M05: Guard — only approve PENDING/PROCESSING payouts with RESERVED commissions.
    // Prevents double-pay by approving a FAILED payout whose commissions were re-withdrawn.
    const payout = await prisma.payout.findUnique({
      where: { id: data.payoutId },
      select: { id: true, status: true },
    })

    if (!payout) {
      return NextResponse.json({ success: false, error: "Payout not found" }, { status: 404 })
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
      return NextResponse.json({ success: false, error: "Payout has no items" }, { status: 409 })
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

    // C-M06: Audit log
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.payout_approved",
      resourceType: "payout",
      resourceId: data.payoutId,
      metadata: { payoutId: data.payoutId, commissionCount: items.length },
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

    // C-M06: Audit log
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.tier_override",
      resourceType: "affiliate",
      resourceId: data.affiliateId,
      metadata: {
        affiliateId: data.affiliateId,
        baseRateBps: data.baseRateBps,
        tierRateBps: data.tierRateBps,
      },
    })

    logger.info("Affiliate tier overridden", {
      affiliateId: data.affiliateId,
      baseRateBps: data.baseRateBps,
      tierRateBps: data.tierRateBps,
      adminUserId: session.userId,
    })
  }

  return NextResponse.json({ success: true })
}
