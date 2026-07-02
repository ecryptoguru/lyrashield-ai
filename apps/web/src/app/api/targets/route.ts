import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { CreateRepoTargetSchema, CreateUrlTargetSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { checkScanUrlSafe } from "../../../lib/ssrf"

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

    const isRepo = typeof body === "object" && body !== null && (body as Record<string, unknown>).type === "REPO"
    const parsed = isRepo ? CreateRepoTargetSchema.safeParse(body) : CreateUrlTargetSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 }
      )
    }

    const data = parsed.data
    const workspaceId = data.workspaceId

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

    if (data.type !== "REPO") {
      const ssrf = await checkScanUrlSafe(data.url)
      if (!ssrf.safe) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "SSRF_BLOCKED",
              message: "This URL is not allowed as a scan target (it targets an internal, private, or unresolvable address).",
            },
          },
          { status: 400 }
        )
      }
    }

    if (data.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: data.projectId, workspaceId },
      })
      if (!project) {
        return NextResponse.json(
          { success: false, error: { code: "PROJECT_NOT_FOUND", message: "Project not found in this workspace" } },
          { status: 404 }
        )
      }
    }

    const targetData =
      data.type === "REPO"
        ? {
            workspaceId,
            projectId: data.projectId ?? null,
            type: "REPO" as const,
            name: data.name,
            repoProvider: data.repoProvider,
            repoOwner: data.repoOwner,
            repoName: data.repoName,
            repoFullName: `${data.repoOwner}/${data.repoName}`,
            branch: data.branch ?? "main",
            environment: data.environment,
          }
        : {
            workspaceId,
            projectId: data.projectId ?? null,
            type: data.type as "WEB_APP" | "API",
            name: data.name,
            url: data.url,
            environment: data.environment,
          }

    const target = await prisma.target.create({ data: targetData })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "target.created",
        resourceType: "target",
        resourceId: target.id,
      },
    })

    logger.info("Target created", { targetId: target.id, workspaceId, type: target.type })

    return NextResponse.json({
      success: true,
      data: {
        id: target.id,
        name: target.name,
        type: target.type,
        workspaceId: target.workspaceId,
      },
    })
  } catch (error) {
    logger.error("Failed to create target", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to create target" } },
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
    const projectId = searchParams.get("projectId")

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

    const targets = await prisma.target.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(projectId ? { projectId } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { scans: true, findings: true } },
      },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json({
      success: true,
      data: targets.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        url: t.url,
        repoFullName: t.repoFullName,
        branch: t.branch,
        environment: t.environment,
        status: t.status,
        lastScanAt: t.lastScanAt,
        project: t.project,
        scanCount: t._count.scans,
        findingCount: t._count.findings,
        createdAt: t.createdAt,
      })),
    })
  } catch (error) {
    logger.error("Failed to list targets", { error: String(error) })
    return NextResponse.json(
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to list targets" } },
      { status: 500 }
    )
  }
}
