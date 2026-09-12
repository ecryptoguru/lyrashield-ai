import { withCookieMutation } from "../../../../../lib/api-auth"
import { z } from "zod"
import { getSystemPrisma, prisma, lockWorkspaceMembership } from "@lyrashield/db"
import { assertBrowserSession, getSession } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { resolveAccountBilling } from "@lyrashield/billing"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

const AcceptSchema = z.object({
  token: z.string().min(1).max(128),
})

const TokenSchema = z.string().min(1).max(128)

/**
 * Invitation metadata for the pre-auth banner on the sign-up/sign-in pages.
 * Only the fields needed to tell the invitee what they are joining; the token
 * itself is an unguessable bearer capability, so holding it is the
 * authorization to see the workspace name.
 */
export async function GET(request: Request) {
  const token = TokenSchema.safeParse(new URL(request.url).searchParams.get("token"))
  if (!token.success) {
    return apiError("MISSING_PARAM", "token is required", 400)
  }

  try {
    const invitation = await getSystemPrisma().invitation.findUnique({
      where: { token: token.data },
      select: {
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        workspace: { select: { name: true } },
      },
    })
    if (!invitation) {
      return apiError("INVITATION_NOT_FOUND", "This invitation link is not valid", 404)
    }
    const expired = invitation.expiresAt.getTime() <= Date.now()
    return apiSuccess({
      email: invitation.email,
      role: invitation.role,
      workspaceName: invitation.workspace.name,
      status: expired ? "expired" : invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
    })
  } catch (error) {
    logger.error("Failed to look up invitation", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to look up invitation", 500)
  }
}

/**
 * Redeem an invitation for the signed-in user. The invitation token reaches
 * the user out-of-band (email/manual link); the accept is authorized by the
 * match between the invitation's email and the signed-in account's verified,
 * current database email, so a copied link cannot add an arbitrary account.
 */
async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }
  const parsed = AcceptSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "token is required", 400)
  }

  try {
    const session = await getSession()
    if (!session) {
      return apiError("UNAUTHORIZED", "Sign in to accept a team invitation", 401)
    }
    // Joining a workspace is account-owned browser activity — a workspace-bound
    // credential must not convert an invitation into membership.
    assertBrowserSession(session)
    const invitation = await getSystemPrisma().invitation.findUnique({
      where: { token: parsed.data.token },
      select: {
        id: true,
        workspaceId: true,
        invitedById: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        workspace: { select: { name: true } },
      },
    })
    if (!invitation || invitation.status !== "pending") {
      return apiError(
        "INVITATION_NOT_FOUND",
        "This invitation is no longer valid (it may have already been accepted)",
        404
      )
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      return apiError(
        "INVITATION_EXPIRED",
        "This invitation has expired. Ask a workspace admin to send a new one.",
        410
      )
    }
    const joined = await getSystemPrisma().$transaction(async (tx) => {
      await lockWorkspaceMembership(tx, invitation.workspaceId)
      // Invitation links can be shared by the inviter. Recheck the persisted
      // Better Auth user after locking, so a stale session or an unverified
      // email address cannot turn a copied link into workspace access.
      const user = await tx.user.findUnique({
        where: { id: session.userId },
        select: { email: true, emailVerified: true },
      })
      if (!user?.emailVerified) throw new Error("INVITATION_EMAIL_UNVERIFIED")
      if (user.email.toLowerCase() !== invitation.email.toLowerCase())
        throw new Error("INVITATION_EMAIL_MISMATCH")
      const existingMember = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: invitation.workspaceId, userId: session.userId },
        },
        select: { status: true },
      })
      if (existingMember?.status !== "active") {
        const workspace = await tx.workspace.findUnique({
          where: { id: invitation.workspaceId },
          select: { agencySponsorAccountId: true },
        })
        const sponsorAccountId = workspace?.agencySponsorAccountId ?? invitation.invitedById
        const owner = await tx.workspaceMember.findFirst({
          where: {
            workspaceId: invitation.workspaceId,
            userId: sponsorAccountId,
            status: "active",
            role: "OWNER",
          },
          select: { id: true },
        })
        const billing = owner ? await resolveAccountBilling(sponsorAccountId, tx) : null
        if (billing?.effectivePlan !== "LAUNCH_ASSURANCE") {
          throw new Error("AGENCY_PLAN_REQUIRED")
        }
        const activeCount = await tx.workspaceMember.count({
          where: { workspaceId: invitation.workspaceId, status: "active" },
        })
        if (activeCount >= CLOUD_PLAN_MAP.LAUNCH_ASSURANCE.memberSeats)
          throw new Error("TEAM_SEAT_LIMIT")
        if (!workspace?.agencySponsorAccountId) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`agency-sponsor:${sponsorAccountId}`}, 0))`
          const otherTeam = await getSystemPrisma().workspace.findFirst({
            where: {
              agencySponsorAccountId: sponsorAccountId,
              deletedAt: null,
              id: { not: invitation.workspaceId },
            },
            select: { id: true },
          })
          if (otherTeam) throw new Error("AGENCY_TEAM_EXISTS")
          await tx.workspace.update({
            where: { id: invitation.workspaceId },
            data: { agencySponsorAccountId: sponsorAccountId },
          })
        }
      }
      const consumed = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          status: "pending",
          expiresAt: { gt: new Date() },
        },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      })

      if (consumed.count !== 1) {
        const existingMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: invitation.workspaceId,
              userId: session.userId,
            },
          },
          select: { status: true },
        })
        if (existingMember?.status === "active") return false
        throw new Error("INVITATION_CONSUME_CONFLICT")
      }

      // An old invitation must never demote an existing owner or change an
      // active member's permissions. Role changes belong to the team route.
      if (existingMember?.status === "active") return false
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId: session.userId,
          },
        },
        update: { status: "active", role: invitation.role },
        create: {
          workspaceId: invitation.workspaceId,
          userId: session.userId,
          role: invitation.role,
          status: "active",
          invitedEmail: invitation.email,
        },
      })
      return true
    })

    if (joined) {
      await prisma.auditLog.create({
        data: {
          workspaceId: invitation.workspaceId,
          actorUserId: session.userId,
          action: "member.joined",
          resourceType: "invitation",
          resourceId: invitation.id,
          metadata: { email: invitation.email, role: invitation.role },
        },
      })
    }

    logger.info("Team invitation accepted", {
      workspaceId: invitation.workspaceId,
      invitationId: invitation.id,
      userId: session.userId,
    })

    return apiSuccess({
      workspaceId: invitation.workspaceId,
      workspaceName: invitation.workspace.name,
      role: invitation.role,
      alreadyMember: !joined,
    })
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_EMAIL_UNVERIFIED") {
      return apiError(
        "INVITATION_EMAIL_UNVERIFIED",
        "Verify your email address before accepting this invitation.",
        403
      )
    }
    if (error instanceof Error && error.message === "INVITATION_EMAIL_MISMATCH") {
      return apiError(
        "INVITATION_EMAIL_MISMATCH",
        "Sign in with the email address that received this invitation.",
        403
      )
    }
    if (error instanceof Error && error.message === "AGENCY_PLAN_REQUIRED") {
      return apiError(
        "AGENCY_PLAN_REQUIRED",
        "The Agency buyer needs an active subscription before this invitation can be accepted.",
        403
      )
    }
    if (error instanceof Error && error.message === "TEAM_SEAT_LIMIT") {
      return apiError("TEAM_SEAT_LIMIT", "This Agency workspace already has five members.", 409)
    }
    if (error instanceof Error && error.message === "AGENCY_TEAM_EXISTS") {
      return apiError(
        "AGENCY_TEAM_EXISTS",
        "This Agency subscription already sponsors another workspace.",
        409
      )
    }
    if (error instanceof Error && error.message === "INVITATION_CONSUME_CONFLICT") {
      return apiError("INVITATION_NOT_FOUND", "This invitation is no longer valid", 409)
    }
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to accept team invitation", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to accept invitation", 500)
  }
}

export const POST = withCookieMutation(post)
