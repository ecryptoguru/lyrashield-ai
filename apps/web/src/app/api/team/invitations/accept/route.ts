import { withCookieMutation } from "../../../../../lib/api-auth"
import { z } from "zod"
import { getSystemPrisma, prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

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
 * match between the invitation's email and the signed-in account's email, so
 * a leaked link cannot add an arbitrary account to a workspace.
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
    const userEmail = (session.userEmail ?? "").toLowerCase()

    const invitation = await getSystemPrisma().invitation.findUnique({
      where: { token: parsed.data.token },
      select: {
        id: true,
        workspaceId: true,
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
    if (invitation.email.toLowerCase() !== userEmail) {
      return apiError(
        "INVITATION_EMAIL_MISMATCH",
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
        403
      )
    }

    const joined = await getSystemPrisma().$transaction(async (tx) => {
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
