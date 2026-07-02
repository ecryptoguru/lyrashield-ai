import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"

const InviteMemberSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.email(),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER", "SECURITY_ADMIN", "APPSEC_MANAGER", "DEVELOPER", "AUDITOR", "BILLING_ADMIN", "EXTERNAL_PENTESTER"]).default("MEMBER"),
})

export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { success: false, error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
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

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: session.userId },
      },
    })

    if (!membership || membership.status !== "active") {
      return NextResponse.json(
        { success: false, error: { code: "FORBIDDEN", message: "You do not have access to this workspace" } },
        { status: 403 }
      )
    }

    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
      return NextResponse.json(
        { success: false, error: { code: "FORBIDDEN", message: "Only owners and admins can invite members" } },
        { status: 403 }
      )
    }

    const [existingMember, existingInvitation] = await Promise.all([
      prisma.workspaceMember.findFirst({
        where: { workspaceId, invitedEmail: email },
      }),
      prisma.invitation.findFirst({
        where: { workspaceId, email, status: "pending" },
      }),
    ])

    if (existingMember || existingInvitation) {
      return NextResponse.json(
        { success: false, error: { code: "ALREADY_INVITED", message: "This email has already been invited" } },
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

    return NextResponse.json({
      success: true,
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    })
  } catch (error) {
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
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return NextResponse.json(
        { success: false, error: { code: "MISSING_PARAM", message: "workspaceId is required" } },
        { status: 400 }
      )
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: session.userId },
      },
    })

    if (!membership || membership.status !== "active") {
      return NextResponse.json(
        { success: false, error: { code: "FORBIDDEN", message: "You do not have access to this workspace" } },
        { status: 403 }
      )
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

    return NextResponse.json({
      success: true,
      data: {
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
      },
    })
  } catch (error) {
    logger.error("Failed to list members", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to list members" } },
      { status: 500 }
    )
  }
}
