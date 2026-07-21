import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession, getWorkspaceMembership } from "@lyrashield/auth/server"
import { UpdateOnboardingSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { getOrCreateOnboardingState } from "@/lib/onboarding-state"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    const state = await getOrCreateOnboardingState(session.userId)

    return NextResponse.json({
      success: true,
      data: {
        id: state.id,
        currentStep: state.currentStep,
        completed: state.completed,
        skipped: state.skipped,
        workspaceId: state.workspaceId,
        targetId: state.targetId,
        selectedGoal: state.selectedGoal,
      },
    })
  } catch (error) {
    logger.error("Failed to get onboarding state", { error: String(error) })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to get onboarding state" },
      },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
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

    const parsed = UpdateOnboardingSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        { status: 400 }
      )
    }

    // Ownership checks: workspaceId / targetId are attacker-controlled foreign
    // keys. Without verification a user could point their onboarding state at
    // any workspace or target in the system (IDOR). Verify the caller is an
    // active member of the workspace, and that the target belongs to a
    // workspace the caller is a member of, before persisting either value.
    if (parsed.data.workspaceId !== undefined && parsed.data.workspaceId !== null) {
      const membership = await getWorkspaceMembership(parsed.data.workspaceId, session.userId)
      if (!membership) {
        return NextResponse.json(
          {
            success: false,
            error: { code: "FORBIDDEN", message: "You do not have access to this workspace" },
          },
          { status: 403 }
        )
      }
    }

    if (parsed.data.targetId !== undefined && parsed.data.targetId !== null) {
      // A targetId is only meaningful alongside a workspace the user belongs to.
      // Reuse the workspace already persisted by step one when this incremental
      // update contains only targetId. Strict RLS must never perform an unscoped
      // lookup by attacker-controlled target id.
      const existingState = parsed.data.workspaceId
        ? null
        : await getOrCreateOnboardingState(session.userId)
      const workspaceId = parsed.data.workspaceId ?? existingState?.workspaceId
      if (!workspaceId) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Complete the workspace step before selecting a target",
            },
          },
          { status: 400 }
        )
      }
      const workspaceMembership = await getWorkspaceMembership(workspaceId, session.userId)
      if (!workspaceMembership) {
        return NextResponse.json(
          {
            success: false,
            error: { code: "FORBIDDEN", message: "You do not have access to this workspace" },
          },
          { status: 403 }
        )
      }
      const target = await prisma.target.findFirst({
        where: { id: parsed.data.targetId, workspaceId },
        select: { workspaceId: true },
      })
      const targetMembership = target
        ? await getWorkspaceMembership(target.workspaceId, session.userId)
        : null
      if (!target || !targetMembership) {
        return NextResponse.json(
          {
            success: false,
            error: { code: "FORBIDDEN", message: "You do not have access to this target" },
          },
          { status: 403 }
        )
      }
    }

    const updateData: Record<string, unknown> = {}
    if (parsed.data.currentStep !== undefined) updateData.currentStep = parsed.data.currentStep
    if (parsed.data.completed !== undefined) updateData.completed = parsed.data.completed
    if (parsed.data.skipped !== undefined) updateData.skipped = parsed.data.skipped
    if (parsed.data.workspaceId !== undefined) updateData.workspaceId = parsed.data.workspaceId
    if (parsed.data.targetId !== undefined) updateData.targetId = parsed.data.targetId
    if (parsed.data.selectedGoal !== undefined) updateData.selectedGoal = parsed.data.selectedGoal

    await getOrCreateOnboardingState(session.userId)
    const state = await prisma.onboardingState.update({
      where: { userId: session.userId },
      data: updateData,
    })

    return NextResponse.json({
      success: true,
      data: {
        id: state.id,
        currentStep: state.currentStep,
        completed: state.completed,
        skipped: state.skipped,
        workspaceId: state.workspaceId,
        targetId: state.targetId,
        selectedGoal: state.selectedGoal,
      },
    })
  } catch (error) {
    logger.error("Failed to update onboarding state", { error: String(error) })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to update onboarding state" },
      },
      { status: 500 }
    )
  }
}
