import { NextResponse } from "next/server"
import { z } from "zod"
import { Prisma, prisma } from "@lyrashield/db"
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
    action: z.literal("reconcilePayout"),
    payoutId: z.string().min(1),
    providerPayoutId: z.string().min(1).max(191),
    providerStatus: z.enum(["processing", "processed", "rejected"]),
  }),
  z.object({
    action: z.literal("verifyPayoutProfile"),
    affiliateId: z.string().min(1),
    payoutMethodVerified: z.boolean(),
    taxStatus: z.enum(["PENDING_REVIEW", "VERIFIED", "REJECTED"]),
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
  } else if (data.action === "verifyPayoutProfile") {
    const existing = await prisma.affiliate.findUnique({
      where: { id: data.affiliateId },
      select: { payoutMethod: true, taxFormType: true },
    })
    if (!existing) {
      return NextResponse.json({ success: false, error: "Affiliate not found" }, { status: 404 })
    }
    const payoutMethod = existing.payoutMethod as Record<string, unknown> | null
    if (data.payoutMethodVerified && !payoutMethod) {
      return NextResponse.json(
        { success: false, error: "Payout method is required" },
        { status: 400 }
      )
    }
    if (data.taxStatus === "VERIFIED" && !existing.taxFormType) {
      return NextResponse.json(
        { success: false, error: "Tax form type is required" },
        { status: 400 }
      )
    }
    await prisma.affiliate.update({
      where: { id: data.affiliateId },
      data: {
        payoutMethod: payoutMethod
          ? { ...payoutMethod, valid: data.payoutMethodVerified }
          : undefined,
        payoutMethodVerifiedAt: data.payoutMethodVerified ? new Date() : null,
        payoutMethodVerifiedBy: data.payoutMethodVerified ? session.userId : null,
        taxFormStatus: data.taxStatus,
        taxReviewedAt: new Date(),
        taxReviewedBy: session.userId,
      },
    })
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.payout_profile_verified",
      resourceType: "affiliate",
      resourceId: data.affiliateId,
      metadata: {
        payoutMethodVerified: data.payoutMethodVerified,
        taxFormType: existing.taxFormType,
        taxStatus: data.taxStatus,
      },
    })
  } else if (data.action === "reconcilePayout") {
    const payout = await prisma.payout.findUnique({
      where: { id: data.payoutId },
      select: {
        id: true,
        status: true,
        isReserveRelease: true,
        amount: true,
        affiliateId: true,
        providerPayoutId: true,
      },
    })

    if (!payout) {
      return NextResponse.json({ success: false, error: "Payout not found" }, { status: 404 })
    }

    // Replay safe: already PAID is idempotent success
    if (payout.status === "PAID") {
      return payout.providerPayoutId === data.providerPayoutId
        ? NextResponse.json({ success: true })
        : NextResponse.json(
            { success: false, error: "Provider payout ID mismatch" },
            { status: 409 }
          )
    }

    if (payout.providerPayoutId && payout.providerPayoutId !== data.providerPayoutId) {
      return NextResponse.json(
        { success: false, error: "Provider payout ID mismatch" },
        { status: 409 }
      )
    }

    if (payout.status !== "PENDING" && payout.status !== "PROCESSING") {
      return NextResponse.json(
        { success: false, error: `Payout is ${payout.status}, not PENDING/PROCESSING` },
        { status: 409 }
      )
    }

    if (data.providerStatus === "processing") {
      const updated = await prisma.payout.updateMany({
        where: { id: data.payoutId, status: { in: ["PENDING", "PROCESSING"] } },
        data: {
          status: "PROCESSING",
          providerPayoutId: data.providerPayoutId,
          failureCode: "PROVIDER_PENDING",
        },
      })
      if (updated.count === 0) {
        return NextResponse.json(
          { success: false, error: "Payout status changed" },
          { status: 409 }
        )
      }
      await writeAffiliateAudit(session.userId, {
        action: "affiliate.payout_reconciled",
        resourceType: "payout",
        resourceId: data.payoutId,
        metadata: { providerPayoutId: data.providerPayoutId, providerStatus: data.providerStatus },
      })
      return NextResponse.json({ success: true, status: "PROCESSING" })
    }

    if (data.providerStatus === "rejected") {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.payout.updateMany({
          where: { id: data.payoutId, status: { in: ["PENDING", "PROCESSING"] } },
          data: {
            status: "FAILED",
            providerPayoutId: data.providerPayoutId,
            failureCode: "PROVIDER_REJECTED",
          },
        })
        if (updated.count === 0) throw new Error("Payout status changed")
        if (!payout.isReserveRelease) {
          const rejectedItems = await tx.payoutItem.findMany({
            where: { payoutId: data.payoutId },
            select: { commissionId: true },
          })
          await tx.commission.updateMany({
            where: {
              id: { in: rejectedItems.map((item) => item.commissionId) },
              status: "RESERVED",
            },
            data: { status: "AVAILABLE" },
          })
          await tx.payoutItem.deleteMany({ where: { payoutId: data.payoutId } })
        }
      })
      await writeAffiliateAudit(session.userId, {
        action: "affiliate.payout_reconciled",
        resourceType: "payout",
        resourceId: data.payoutId,
        metadata: { providerPayoutId: data.providerPayoutId, providerStatus: data.providerStatus },
      })
      return NextResponse.json({ success: true, status: "FAILED" })
    }

    const items = await prisma.payoutItem.findMany({
      where: { payoutId: data.payoutId },
      select: { commissionId: true, amount: true },
    })

    if (items.length === 0) {
      return NextResponse.json({ success: false, error: "Payout has no items" }, { status: 409 })
    }

    const commissions = await prisma.commission.findMany({
      where: { id: { in: items.map((i) => i.commissionId) } },
      select: {
        id: true,
        status: true,
        affiliateId: true,
        reserveReleasedAt: true,
        reserveReleasedAmount: true,
        amount: true,
      },
    })

    if (!payout.isReserveRelease) {
      // Ordinary payout: must be all RESERVED and owned by payout.affiliateId
      const allReserved =
        commissions.length === items.length && commissions.every((c) => c.status === "RESERVED")
      const ownershipOk = commissions.every((c) => c.affiliateId === payout.affiliateId)
      if (!allReserved || !ownershipOk) {
        return NextResponse.json(
          { success: false, error: "Payout commissions are not all RESERVED" },
          { status: 409 }
        )
      }

      await prisma.$transaction(async (tx) => {
        const upd = await tx.payout.updateMany({
          where: { id: data.payoutId, status: { in: ["PENDING", "PROCESSING"] } },
          data: { status: "PAID", paidAt: new Date(), providerPayoutId: data.providerPayoutId },
        })
        if (upd.count === 0) {
          const existing = await tx.payout.findUnique({
            where: { id: data.payoutId },
            select: { status: true },
          })
          if (existing?.status === "PAID") return
          throw new Error("Payout status changed concurrently")
        }
        await tx.commission.updateMany({
          where: { id: { in: items.map((i) => i.commissionId) }, status: "RESERVED" },
          data: { status: "PAID" },
        })
      })
    } else {
      // Reserve-release payout: validate reserveReleasedAt, ownership, amount, replay identity
      if (commissions.length !== items.length) {
        return NextResponse.json(
          { success: false, error: "Payout items do not match commissions" },
          { status: 409 }
        )
      }
      const ownershipOk = commissions.every((c) => c.affiliateId === payout.affiliateId)
      if (!ownershipOk) {
        return NextResponse.json(
          { success: false, error: "Reserve-release ownership mismatch" },
          { status: 409 }
        )
      }
      const allReleased = commissions.every((c) => c.reserveReleasedAt !== null)
      if (!allReleased) {
        return NextResponse.json(
          { success: false, error: "Reserve not yet released for all commissions" },
          { status: 409 }
        )
      }
      // Amount validation: payout.amount must equal sum of payoutItems, and each item must match reserveReleasedAmount
      const sum = items.reduce(
        (acc: InstanceType<typeof Prisma.Decimal>, i: { amount: unknown }) => {
          const dec =
            i.amount instanceof Prisma.Decimal
              ? (i.amount as InstanceType<typeof Prisma.Decimal>)
              : new Prisma.Decimal(String(i.amount))
          return (
            acc as unknown as { add: (v: unknown) => InstanceType<typeof Prisma.Decimal> }
          ).add(dec)
        },
        new Prisma.Decimal(0) as InstanceType<typeof Prisma.Decimal>
      )
      const payoutAmount =
        payout.amount instanceof Prisma.Decimal
          ? (payout.amount as InstanceType<typeof Prisma.Decimal>)
          : new Prisma.Decimal(String(payout.amount))
      if (!sum.equals(payoutAmount)) {
        return NextResponse.json(
          { success: false, error: "Payout amount does not match sum of items" },
          { status: 409 }
        )
      }
      // Per-commission amount identity (replay safe): each item amount must equal commission.reserveReleasedAmount
      for (const item of items) {
        const c = commissions.find((cc) => cc.id === item.commissionId)
        if (!c) continue
        if (c.reserveReleasedAmount !== null && c.reserveReleasedAmount !== undefined) {
          if (!new Prisma.Decimal(String(item.amount)).equals(c.reserveReleasedAmount)) {
            return NextResponse.json(
              { success: false, error: "Reserve-release amount mismatch" },
              { status: 409 }
            )
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        const upd = await tx.payout.updateMany({
          where: { id: data.payoutId, status: { in: ["PENDING", "PROCESSING"] } },
          data: { status: "PAID", paidAt: new Date(), providerPayoutId: data.providerPayoutId },
        })
        if (upd.count === 0) {
          const existing = await tx.payout.findUnique({
            where: { id: data.payoutId },
            select: { status: true },
          })
          if (existing?.status === "PAID") return
          throw new Error("Payout status changed concurrently")
        }
        // No commission status change — commissions already PAID, reserve already marked
      })
    }

    // C-M06: Audit log
    await writeAffiliateAudit(session.userId, {
      action: "affiliate.payout_reconciled",
      resourceType: "payout",
      resourceId: data.payoutId,
      metadata: {
        payoutId: data.payoutId,
        providerPayoutId: data.providerPayoutId,
        providerStatus: data.providerStatus,
        commissionCount: items.length,
      },
    })

    logger.info("Payout reconciled", { payoutId: data.payoutId, adminUserId: session.userId })
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
