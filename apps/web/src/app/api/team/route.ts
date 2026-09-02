import { withCookieMutation } from "../../../lib/api-auth"
import { NextResponse } from "next/server"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS, canGrantRole, hasPermission } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { sendNotification } from "@lyrashield/integrations"
import { z } from "zod"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { checkInvitationCreateRateLimit } from "../../../lib/rate-limit"

const InviteMemberSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.email(),
  role: z
    .enum([
      "ADMIN",
      "MEMBER",
      "VIEWER",
      "SECURITY_ADMIN",
      "APPSEC_MANAGER",
      "DEVELOPER",
      "AUDITOR",
      "BILLING_ADMIN",
      "EXTERNAL_PENTESTER",
    ])
    .default("MEMBER"),
})

const ChangeMemberSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
    role: z.enum([
      "OWNER",
      "ADMIN",
      "MEMBER",
      "VIEWER",
      "SECURITY_ADMIN",
      "APPSEC_MANAGER",
      "DEVELOPER",
      "AUDITOR",
      "BILLING_ADMIN",
      "EXTERNAL_PENTESTER",
    ]),
  })
  .strict()

async function changeMember(
  input: z.infer<typeof ChangeMemberSchema> | Omit<z.infer<typeof ChangeMemberSchema>, "role">
) {
  const { workspaceId, memberId } = input
  const role = "role" in input ? input.role : undefined
  const permission = role ? PERMISSIONS.member.updateRole : PERMISSIONS.member.remove
  const { session } = await requirePermission(workspaceId, permission)
  const result = await withWorkspaceRLS(workspaceId, async (tx) => {
    // Serialize membership changes and recheck the actor after taking the lock.
    // Two owners cannot concurrently remove/demote each other or the final owner.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const actor = await tx.workspaceMember.findFirst({
      where: { workspaceId, userId: session.userId, status: "active" },
    })
    const member = await tx.workspaceMember.findFirst({
      where: { id: memberId, workspaceId, status: "active" },
    })
    if (!actor || !hasPermission(actor.role, permission)) throw new Error("FORBIDDEN")
    if (!member) return apiError("NOT_FOUND", "Member not found", 404)
    if (!canGrantRole(actor.role, member.role) || (role && !canGrantRole(actor.role, role))) {
      return apiError("FORBIDDEN", "You cannot manage a role equal to or higher than your own", 403)
    }
    if (member.role === "OWNER" && role !== "OWNER") {
      const owners = await tx.workspaceMember.count({
        where: { workspaceId, status: "active", role: "OWNER" },
      })
      if (owners <= 1)
        return apiError("LAST_OWNER", "The workspace must keep at least one owner", 409)
    }
    await tx.workspaceMember.updateMany({
      where: { id: memberId, workspaceId, status: "active" },
      data: role ? { role } : { status: "removed" },
    })
    return { previousRole: member.role, userId: member.userId }
  })
  if (result instanceof Response) return result
  // The extended audit client owns its chain transaction; do not nest it above.
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorUserId: session.userId,
      action: role ? "member.role_changed" : "member.removed",
      resourceType: "workspaceMember",
      resourceId: memberId,
      metadata: { ...result, ...(role ? { role } : {}) },
    },
  })
  return apiSuccess({ id: memberId })
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    const parsed = ChangeMemberSchema.safeParse(body)
    if (!parsed.success)
      return apiError(
        "VALIDATION_ERROR",
        "workspaceId, memberId and a valid role are required",
        400
      )
    return await changeMember(parsed.data)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to change member role", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to change member role", 500)
  }
}

export async function DELETE(request: Request) {
  try {
    const parsed = ChangeMemberSchema.omit({ role: true }).safeParse(
      Object.fromEntries(new URL(request.url).searchParams)
    )
    if (!parsed.success)
      return apiError("VALIDATION_ERROR", "workspaceId and memberId are required", 400)
    return await changeMember(parsed.data)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to remove member", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to remove member", 500)
  }
}

/**
 * The accept link an invited member follows. It points at sign-up with the
 * invitation token as a query param — invited members have no account yet.
 */
function inviteAcceptUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  return `${base}/sign-up?invite=${token}`
}

/**
 * Best-effort invite email. Never throws: a missing Brevo config or a failed
 * send must not fail the invitation itself — the accept URL is returned to the
 * inviter in the POST response either way so the link can be shared manually.
 */
async function sendInvitationEmail(params: {
  email: string
  workspaceName: string | null
  role: string
  acceptUrl: string
}): Promise<boolean> {
  const workspaceLabel = params.workspaceName ?? "a workspace"
  try {
    return await sendNotification(
      "email",
      {
        type: "team.invitation",
        title: `You've been invited to join ${workspaceLabel} on LyraShield AI`,
        body: `You've been invited to join ${workspaceLabel} on LyraShield AI as ${params.role}. Accept the invitation with this link (valid for 7 days): ${params.acceptUrl}`,
        workspaceName: params.workspaceName ?? undefined,
      },
      [params.email]
    )
  } catch (error) {
    logger.error("Invitation email send threw", { error: String(error), email: params.email })
    return false
  }
}

async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
      },
      { status: 400 }
    )
  }

  const parsed = InviteMemberSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 }
    )
  }

  const { workspaceId, email, role } = parsed.data

  try {
    // Enforces membership + the `member:invite` permission (OWNER and ADMIN only).
    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.member.invite)

    // Role-ceiling: the inviter may only grant roles below their own rank (OWNER
    // may grant anything). Without this, an ADMIN could invite a peer ADMIN or
    // otherwise escalate. (S6)
    if (!canGrantRole(workspace.role, role)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You cannot grant a role equal to or higher than your own",
          },
        },
        { status: 403 }
      )
    }

    // Invitation creation mints a 7-day bearer token and triggers an outbound
    // email — bound it per workspace so a runaway client cannot flood either.
    const inviteRate = await checkInvitationCreateRateLimit(workspaceId)
    if (inviteRate.limited) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "INVITE_RATE_LIMITED",
            message:
              "Too many invitations created in the last minute. Please wait a moment and try again.",
          },
        },
        { status: 429, headers: { "Retry-After": String(Math.max(inviteRate.retryAfter, 1)) } }
      )
    }

    const [existingMember, existingInvitation, workspaceRow] = await Promise.all([
      prisma.workspaceMember.findFirst({
        where: { workspaceId, invitedEmail: email },
      }),
      prisma.invitation.findFirst({
        where: { workspaceId, email, status: "pending" },
      }),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      }),
    ])

    if (existingMember || existingInvitation) {
      return NextResponse.json(
        {
          success: false,
          error: { code: "ALREADY_INVITED", message: "This email has already been invited" },
        },
        { status: 409 }
      )
    }

    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const invitation = await prisma.invitation.create({
      data: {
        workspaceId,
        email,
        role,
        token,
        invitedById: session.userId,
        expiresAt,
      },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "member.invited",
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: { email, role },
      },
    })

    logger.info("Member invited", { workspaceId, email, role, userId: session.userId })

    // Best-effort: the invitation row already exists and is authoritative — an
    // email failure is logged, never surfaced as a failed invite. The inviter
    // gets the accept URL in the response regardless, so the link can be shared
    // manually when email is unconfigured or the send fails.
    const acceptUrl = inviteAcceptUrl(token)
    const emailSent = await sendInvitationEmail({
      email,
      workspaceName: workspaceRow?.name ?? null,
      role,
      acceptUrl,
    })
    if (!emailSent) {
      logger.warn("Invitation email not delivered — share the accept URL manually", {
        workspaceId,
        invitationId: invitation.id,
        email,
      })
    }

    return NextResponse.json({
      success: true,
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        inviteUrl: acceptUrl,
        emailSent,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to invite member", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to invite member" } },
      { status: 500 }
    )
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return apiError("UNAUTHORIZED", "Authentication required", 401)
    }

    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: session.userId },
      },
    })

    if (!membership || membership.status !== "active") {
      return apiError("FORBIDDEN", "You do not have access to this workspace", 403)
    }

    const [members, invitations] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId, status: "active" },
        include: {
          workspace: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.invitation.findMany({
        where: { workspaceId, status: "pending" },
        orderBy: { createdAt: "desc" },
      }),
    ])

    const userIds = members.map((m) => m.userId)
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, image: true },
    })

    return apiSuccess({
      members: members.map((m) => {
        const user = users.find((u) => u.id === m.userId)
        return {
          id: m.id,
          userId: m.userId,
          name: user?.name ?? "Unknown",
          email: user?.email ?? m.invitedEmail ?? "",
          image: user?.image,
          role: m.role,
          status: m.status,
          createdAt: m.createdAt,
        }
      }),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    })
  } catch (error) {
    logger.error("Failed to list members", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list members", 500)
  }
}

export const POST = withCookieMutation(post)
