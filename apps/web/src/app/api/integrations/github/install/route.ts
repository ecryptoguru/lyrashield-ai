import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getSession, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  getInstallAppUrl,
  getAppInstallations,
  exchangeInstallUserCode,
  getUserAdminInstallations,
} from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "../../../../../lib/api-auth"
import { createInstallState, verifyInstallState } from "../../../../../lib/github-install-state"
import {
  githubSessionIdentity,
  matchesGitHubSession,
  type GitHubContext,
} from "@/lib/github-oauth-context"
import { getAppOrigin, githubAuthorizationUrl, githubReturnPath } from "@/lib/github-install-urls"
import { bindGitHubInstallation } from "@/lib/github-install-binding"
import { verifyOAuthOnboardingReturn } from "@/lib/oauth-onboarding-return"

const InstallRequestSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  oauthReturnState: z.string().max(8192).optional(),
  returnTo: z.enum(["onboarding", "integrations", "scan"]).default("integrations"),
  mode: z.enum(["existing", "install-new"]).default("existing"),
  chooserState: z.string().max(24000).optional(),
  selectedId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
})
const invalidState = () =>
  NextResponse.json(
    {
      success: false,
      error: {
        code: "INVALID_STATE",
        message: "Connection expired. Start again from Connect GitHub.",
      },
    },
    { status: 400 }
  )

export async function GET(request: NextRequest) {
  const origin = getAppOrigin(request)
  const session = await getSession()
  if (!session) return NextResponse.redirect(new URL("/sign-in?callbackUrl=/onboarding", origin))
  const params = request.nextUrl.searchParams
  const state = verifyInstallState(params.get("state") ?? "")
  if (!state.valid || state.github?.purpose === "github-choose") return invalidState()
  const returnPath = githubReturnPath(state, session.userId)
  const outcome = (status: string) => {
    const url = new URL(returnPath, origin)
    url.searchParams.set("github", status)
    return NextResponse.redirect(url)
  }
  try {
    const { session: authorized } = await requirePermission(
      state.workspaceId,
      PERMISSIONS.integration.manage
    )
    const identity = githubSessionIdentity(authorized)
    if (
      state.github &&
      (!matchesGitHubSession(state.github, session) ||
        !matchesGitHubSession(state.github, authorized))
    )
      return outcome("session_changed")
    if (params.has("error")) return outcome("cancelled")
    const rawId = params.get("installation_id")
    if (rawId !== null && (!/^[1-9][0-9]*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))))
      return invalidState()
    const selectedId =
      state.github && "selectedId" in state.github
        ? state.github.selectedId
        : state.github?.purpose === "github-install" && rawId
          ? Number(rawId)
          : undefined
    if (selectedId !== undefined && rawId !== null && Number(rawId) !== selectedId)
      return invalidState()
    const code = params.get("code")
    // Legacy state cannot authorize a grant. A completed install without code
    // gets a new session-bound OAuth proof, then must return with a fresh code.
    if (!state.github || (!code && state.github.purpose === "github-install")) {
      const github: GitHubContext = selectedId
        ? { ...identity, purpose: "github-prove", selectedId }
        : { ...identity, purpose: "github-discover" }
      return NextResponse.redirect(
        githubAuthorizationUrl(
          origin,
          createInstallState(
            state.workspaceId,
            state.returnTo,
            Date.now(),
            state.oauthReturnState,
            github
          )
        )
      )
    }
    if (!code || code.length > 2048) return outcome("verification_required")
    let proof: Awaited<ReturnType<typeof getUserAdminInstallations>>
    try {
      const token = await exchangeInstallUserCode(code)
      proof = await getUserAdminInstallations(token, selectedId)
    } catch {
      // Never log provider tokens, codes or response bodies.
      logger.warn("GitHub ownership proof unavailable", { workspaceId: state.workspaceId })
      return outcome("verification_required")
    }
    if (state.github.purpose === "github-selected" && proof.userId !== state.github.providerUserId)
      return outcome("identity_changed")
    const appInstallations = await getAppInstallations()
    const eligible = proof.installations.filter((candidate) =>
      appInstallations.some((i) => i.id === candidate.id)
    )
    if (!eligible.length) return outcome(selectedId ? "verification_required" : "no_installations")
    if (eligible.length > 1) {
      const chooser = createInstallState(
        state.workspaceId,
        state.returnTo,
        Date.now(),
        state.oauthReturnState,
        {
          ...identity,
          purpose: "github-choose",
          providerUserId: proof.userId,
          candidates: eligible,
        }
      )
      const url = new URL("/integrations/github/choose", origin)
      url.searchParams.set("state", chooser)
      return NextResponse.redirect(url)
    }
    const installation = appInstallations.find((i) => i.id === eligible[0]!.id)!
    return await bindGitHubInstallation({
      installation,
      workspaceId: state.workspaceId,
      userId: authorized.userId,
      setupAction: params.get("setup_action"),
      returnPath,
      origin,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to connect GitHub installation", { workspaceId: state.workspaceId })
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to connect GitHub installation" },
      },
      { status: 500 }
    )
  }
}

async function post(request: NextRequest) {
  const session = await getSession()
  if (!session)
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      { status: 401 }
    )
  const parsed = InstallRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return NextResponse.json(
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection request" },
      },
      { status: 400 }
    )
  const { workspaceId, returnTo, oauthReturnState, mode, chooserState, selectedId } = parsed.data
  try {
    const { session: authorized } = await requirePermission(
      workspaceId,
      PERMISSIONS.integration.manage
    )
    const identity = githubSessionIdentity(authorized)
    if (session.userId !== authorized.userId || session.sessionId !== authorized.sessionId)
      return invalidState()
    let github: GitHubContext = {
      ...identity,
      purpose: mode === "install-new" ? "github-install" : "github-discover",
    }
    let destination = returnTo
    let oauthState = oauthReturnState
    if (chooserState || selectedId !== undefined) {
      if (!chooserState || selectedId === undefined || mode !== "existing") return invalidState()
      const chooser = verifyInstallState(chooserState)
      if (
        !chooser.valid ||
        chooser.workspaceId !== workspaceId ||
        chooser.github?.purpose !== "github-choose" ||
        !matchesGitHubSession(chooser.github, session) ||
        !chooser.github.candidates.some((c) => c.id === selectedId)
      )
        return invalidState()
      github = {
        ...identity,
        purpose: "github-selected",
        selectedId,
        providerUserId: chooser.github.providerUserId,
      }
      destination = chooser.returnTo
      oauthState = chooser.oauthReturnState
    }
    if (oauthState) {
      const verified = verifyOAuthOnboardingReturn(oauthState)
      if (!verified.valid || verified.userId !== session.userId) return invalidState()
    }
    const state = createInstallState(workspaceId, destination, Date.now(), oauthState, github)
    const url =
      mode === "install-new"
        ? new URL(getInstallAppUrl())
        : githubAuthorizationUrl(getAppOrigin(request), state)
    url.searchParams.set("state", state)
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.github.connect_started",
        resourceType: "integration",
      },
    })
    return NextResponse.json({ success: true, data: { installUrl: url.toString() } })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to build GitHub connection URL")
    return NextResponse.json(
      { success: false, error: { code: "CONFIG_ERROR", message: "GitHub App is not configured" } },
      { status: 500 }
    )
  }
}
export const POST = withCookieMutation(post)
