import { NextResponse } from "next/server"
import { getSession } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { withCookieMutation } from "@/lib/api-auth"
import { onboardingWorkspaceRequestSchema } from "@/lib/onboarding-workspace-schema"
import {
  chooseOrCreateOnboardingWorkspace,
  listOnboardingWorkspaces,
  OnboardingWorkspaceError,
} from "@/lib/onboarding-workspace"

const failure = (code: string, message: string, status: number) =>
  NextResponse.json({ success: false, error: { code, message } }, { status })
async function browserSession() {
  const session = await getSession()
  if (!session) return failure("UNAUTHORIZED", "Authentication required", 401)
  if (session.apiKey || session.oauth)
    return failure("FORBIDDEN", "Workspace setup requires a browser session", 403)
  return session
}

export async function GET() {
  const session = await browserSession()
  if (session instanceof Response) return session
  try {
    return NextResponse.json({
      success: true,
      data: await listOnboardingWorkspaces(session.userId),
    })
  } catch (error) {
    logger.error("Failed to list onboarding workspaces", { error: String(error) })
    return failure("INTERNAL_ERROR", "Could not load workspaces", 500)
  }
}

async function post(request: Request) {
  const session = await browserSession()
  if (session instanceof Response) return session
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return failure("INVALID_JSON", "Request body must be valid JSON", 400)
  }
  const parsed = onboardingWorkspaceRequestSchema.safeParse(body)
  if (!parsed.success)
    return failure("VALIDATION_ERROR", "Choose a workspace or enter a valid workspace name", 400)
  try {
    const result = await chooseOrCreateOnboardingWorkspace(session.userId, parsed.data)
    return NextResponse.json({
      success: true,
      data: {
        state: { ...result.state, updatedAt: result.state.updatedAt.toISOString() },
        workspace: result.workspace,
        trialStarted: result.trialStarted,
      },
    })
  } catch (error) {
    if (error instanceof OnboardingWorkspaceError) {
      return error.code === "WORKSPACE_UNAVAILABLE"
        ? failure(
            error.code,
            "This workspace is no longer available for setup. Choose another workspace or create one.",
            403
          )
        : failure(
            error.code,
            "Setup changed in another tab. Reload to continue from the latest step.",
            409
          )
    }
    logger.error("Failed to prepare onboarding workspace", { error: String(error) })
    return failure("INTERNAL_ERROR", "Could not prepare your workspace. Please retry.", 500)
  }
}
export const POST = withCookieMutation(post)
