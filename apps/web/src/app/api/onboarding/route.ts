import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { UpdateOnboardingSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"

export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 }
      )
    }

    let state = await prisma.onboardingState.findUnique({
      where: { userId: session.userId },
    })

    if (!state) {
      state = await prisma.onboardingState.create({
        data: { userId: session.userId },
      })
    }

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
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to get onboarding state" } },
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
        { success: false, error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } },
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

    const updateData: Record<string, unknown> = {}
    if (parsed.data.currentStep !== undefined) updateData.currentStep = parsed.data.currentStep
    if (parsed.data.completed !== undefined) updateData.completed = parsed.data.completed
    if (parsed.data.skipped !== undefined) updateData.skipped = parsed.data.skipped
    if (parsed.data.workspaceId !== undefined) updateData.workspaceId = parsed.data.workspaceId
    if (parsed.data.targetId !== undefined) updateData.targetId = parsed.data.targetId
    if (parsed.data.selectedGoal !== undefined) updateData.selectedGoal = parsed.data.selectedGoal

    const state = await prisma.onboardingState.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, ...updateData },
      update: updateData,
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
      { success: false, error: { code: "INTERNAL_ERROR", message: "Failed to update onboarding state" } },
      { status: 500 }
    )
  }
}
