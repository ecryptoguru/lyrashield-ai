import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateRepoTargetSchema, CreateUrlTargetSchema } from "@lyrashield/types"
import { revalidateDashboardAggregates } from "../../../lib/cache"
import { logger } from "@lyrashield/logger"
import { checkScanUrlSafe } from "../../../lib/ssrf"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"
import { assertTargetAllowed } from "@lyrashield/billing"

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

  const isRepo =
    typeof body === "object" && body !== null && (body as Record<string, unknown>).type === "REPO"
  const parsed = isRepo
    ? CreateRepoTargetSchema.safeParse(body)
    : CreateUrlTargetSchema.safeParse(body)

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
      const ssrf = await checkScanUrlSafe(data.url)
      if (!ssrf.safe) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "SSRF_BLOCKED",
              message:
                "This URL is not allowed as a scan target (it targets an internal, private, or unresolvable address).",
            },
          },
          { status: 400 }
        )
      }

      if (data.apiSpecUrl) {
        const specSsrf = await checkScanUrlSafe(data.apiSpecUrl)
        if (!specSsrf.safe) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: "SSRF_BLOCKED",
                message:
                  "This OpenAPI URL is not allowed (it targets an internal, private, or unresolvable address).",
              },
            },
            { status: 400 }
          )
        }
      }
    }

    if (data.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: data.projectId, workspaceId },
      })
      if (!project) {
        return NextResponse.json(
          {
            success: false,
            error: { code: "PROJECT_NOT_FOUND", message: "Project not found in this workspace" },
          },
          { status: 404 }
        )
      }
    }

    const entitlement = await assertTargetAllowed(workspaceId)
    if (!entitlement.allowed) {
      return apiError(
        entitlement.code ?? "TARGET_NOT_ALLOWED",
        entitlement.message ?? "Target not allowed",
        403,
        undefined,
        { targetsUsed: entitlement.targetsUsed, targetCap: entitlement.targetCap }
      )
    }

    // A caller-supplied installationId must belong to an active GitHub
    // integration in THIS workspace. Without this check a client could tag a
    // target with a foreign or invented installation id, which would then never
    // match on App-uninstall cleanup and would leave the target active forever.
    if (data.type === "REPO" && data.installationId) {
      const ownedInstallation = await prisma.integration.findFirst({
        where: {
          workspaceId,
          type: "GITHUB",
          externalId: data.installationId,
          status: "active",
          deletedAt: null,
        },
        select: { id: true },
      })
      if (!ownedInstallation) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "INSTALLATION_NOT_FOUND",
              message:
                "The provided installationId does not match an active GitHub integration for this workspace",
            },
          },
          { status: 400 }
        )
      }
    }

    const repoInstallationId =
      data.type === "REPO"
        ? (data.installationId ??
          (
            await prisma.integration.findFirst({
              where: {
                workspaceId,
                type: "GITHUB",
                status: "active",
                deletedAt: null,
              },
              select: { externalId: true },
              orderBy: { createdAt: "desc" },
            })
          )?.externalId)
        : undefined

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
            installationId: repoInstallationId ?? null,
            // Do not force "main" — a repo whose default branch is master (or
            // anything else) would fail to clone with "Remote branch main not
            // found". Leave it null so the engine clones the remote's default
            // branch; the engine only pins --repository-branch when one is set.
            branch: data.branch ?? null,
            environment: data.environment,
          }
        : {
            workspaceId,
            projectId: data.projectId ?? null,
            type: data.type as "WEB_APP" | "API",
            name: data.name,
            url: data.url,
            apiSpecUrl: data.apiSpecUrl ?? null,
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

    if (data.type !== "REPO" && data.ownershipAttested) {
      await prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: session.userId,
          action: "target.ownership_attested",
          resourceType: "target",
          resourceId: target.id,
        },
      })
    }

    logger.info("Target created", { targetId: target.id, workspaceId, type: target.type })

    revalidateDashboardAggregates()

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
      return apiError("UNAUTHORIZED", "Authentication required", 401)
    }

    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const projectId = searchParams.get("projectId")

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
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const hasMore = targets.length > limit
    const items = hasMore ? targets.slice(0, limit) : targets
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

    return apiPaginated(
      items.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        url: t.url,
        apiSpecUrl: t.apiSpecUrl,
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
      nextCursor
    )
  } catch (error) {
    logger.error("Failed to list targets", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list targets", 500)
  }
}
