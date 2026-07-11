import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateProjectSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"

export async function POST(request: Request) {
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

    const { cursor, limit } = parsePaginationParams(searchParams)

    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { targets: true, scans: true, findings: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const hasMore = projects.length > limit
    const items = hasMore ? projects.slice(0, limit) : projects
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

    return apiPaginated(
      items.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        riskScore: p.riskScore,
        createdAt: p.createdAt,
        targetCount: p._count.targets,
        scanCount: p._count.scans,
        findingCount: p._count.findings,
      })),
      nextCursor
    )
  } catch (error) {
    logger.error("Failed to list projects", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list projects", 500)
  }
}
