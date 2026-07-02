import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateRepoTargetSchema, CreateUrlTargetSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"

// NOTE: SSRF validation here is the existing (weak) inline blocklist. It is replaced
// by the shared `checkScanUrlSafe` helper in the companion PR `fix/ssrf-hardening`.
// Both PRs touch this file in different regions; merge the SSRF PR first, then rebase.
const SSRF_BLOCKED_PATTERNS = [
  "127.",
  "0.0.0.0",
  "10.",
  "192.168.",
  "169.254.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "::1",
  "::ffff:",
  "fc00:",
  "fe80:",
  "fd00:",
  "localhost",
  "metadata.google.internal",
]

function isSsrfSafe(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    if (hostname.endsWith(".")) {
      return false
    }

    return !SSRF_BLOCKED_PATTERNS.some((p) => hostname === p || hostname.startsWith(p))
  } catch {
    return false
  }
}

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

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.target.create)

    if (data.type !== "REPO") {
      if (!isSsrfSafe(data.url)) {
        return NextResponse.json(
          { success: false, error: { code: "SSRF_BLOCKED", message: "URL targets internal/private ranges are not allowed" } },
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
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
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
