import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { CreateWorkspaceSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"

function isPrismaUniqueError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  )
}

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
        {
          success: false,
          error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
        },
        { status: 400 }
      )
    }

    const parsed = CreateWorkspaceSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 }
      )
    }

    const { name, mode } = parsed.data
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")

    if (!slug) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "INVALID_NAME",
            message: "Workspace name must contain at least one alphanumeric character",
          },
        },
        { status: 400 }
      )
    }

    const existing = await prisma.workspace.findUnique({ where: { slug } })
    if (existing) {
      return NextResponse.json(
        { success: false, error: { code: "SLUG_TAKEN", message: "Workspace slug already exists" } },
        { status: 409 }
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name,
          slug,
          mode,
          plan: "FREE",
        },
      })

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: session.userId,
          role: "OWNER",
          status: "active",
        },
      })

      await tx.policy.create({
        data: {
          workspaceId: workspace.id,
          name: "Default Policy",
          description: "Default scan policy with safe settings",
          networkEgressPolicy: "target_only",
          destructiveTestsAllowed: false,
          approvalRequired: false,
          maxDurationMinutes: 60,
          piiRedactionEnabled: true,
          evidenceRetentionDays: 30,
        },
      })

      return workspace
    })

    await prisma.auditLog.create({
      data: {
        workspaceId: result.id,
        actorUserId: session.userId,
        action: "workspace.created",
        resourceType: "workspace",
        resourceId: result.id,
      },
    })

    logger.info("Workspace created", { workspaceId: result.id, userId: session.userId })

    return NextResponse.json({
      success: true,
      data: {
        id: result.id,
        name: result.name,
        slug: result.slug,
        mode: result.mode,
        plan: result.plan,
      },
    })
  } catch (error) {
    if (isPrismaUniqueError(error)) {
      return NextResponse.json(
        { success: false, error: { code: "SLUG_TAKEN", message: "Workspace slug already exists" } },
        { status: 409 }
      )
    }
    logger.error("Failed to create workspace", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to create workspace" } },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    const members = await prisma.workspaceMember.findMany({
      where: { userId: session.userId, status: "active" },
      include: { workspace: true },
    })

    return NextResponse.json({
      success: true,
      data: members.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        mode: m.workspace.mode,
        plan: m.workspace.plan,
        role: m.role,
      })),
    })
  } catch (error) {
    logger.error("Failed to list workspaces", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to list workspaces" } },
      { status: 500 }
    )
  }
}
