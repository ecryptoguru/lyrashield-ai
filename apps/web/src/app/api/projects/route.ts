import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateProjectSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
      { status: 400 }
    )
  }

  const parsed = CreateProjectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 }
    )
  }

  const { workspaceId, name, description } = parsed.data

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.project.create)

    const project = await prisma.project.create({
      data: {
        workspaceId,
        name,
        description,
        ownerUserId: session.userId,
      },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "project.created",
        resourceType: "project",
        resourceId: project.id,
      },
    })

    logger.info("Project created", { projectId: project.id, workspaceId, userId: session.userId })

    return NextResponse.json({
      success: true,
      data: {
        id: project.id,
        name: project.name,
        description: project.description,
        workspaceId: project.workspaceId,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create project", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to create project" } },
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

    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { targets: true, scans: true, findings: true } },
      },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json({
      success: true,
      data: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        riskScore: p.riskScore,
        createdAt: p.createdAt,
        targetCount: p._count.targets,
        scanCount: p._count.scans,
        findingCount: p._count.findings,
      })),
    })
  } catch (error) {
    logger.error("Failed to list projects", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to list projects" } },
      { status: 500 }
    )
  }
}
