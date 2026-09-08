import { withCookieMutation } from "../../../lib/api-auth"
import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { CreateWorkspaceSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { createWorkspaceWithTrial } from "../../../lib/workspace-creation"

function isPrismaUniqueError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  )
}

async function post(request: Request) {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    if (session.apiKey || session.oauth) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Workspace-bound credentials cannot create another workspace",
          },
        },
        { status: 403 }
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

    const parsed = CreateWorkspaceSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 }
      )
    }

    const workspace = await createWorkspaceWithTrial({
      userId: session.userId,
      name: parsed.data.name,
      mode: parsed.data.mode,
    })

    logger.info("Workspace created", {
      workspaceId: workspace.id,
      userId: session.userId,
      trialStarted: workspace.trialStarted,
    })

    return NextResponse.json({
      success: true,
      data: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        mode: workspace.mode,
        plan: workspace.plan,
        trialStarted: workspace.trialStarted,
        trialAlreadyUsed: workspace.trialAlreadyUsed,
        trialEndsAt: workspace.trialEndsAt,
      },
    })
  } catch (error) {
    if (isPrismaUniqueError(error)) {
      return NextResponse.json(
        { success: false, error: { code: "SLUG_TAKEN", message: "Workspace slug already exists" } },
        { status: 409 }
      )
    }
    if (
      error instanceof Error &&
      error.message === "INVALID_NAME"
    ) {
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
      where: {
        userId: session.userId,
        status: "active",
        ...((session.apiKey?.workspaceId ?? session.oauth?.workspaceId)
          ? { workspaceId: session.apiKey?.workspaceId ?? session.oauth?.workspaceId }
          : {}),
        workspace: { deletedAt: null },
      },
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

export const POST = withCookieMutation(post)
