import { redirect } from "next/navigation"
import { getWorkspaceMembership, getSession } from "@lyrashield/auth/server"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { ShieldCheck } from "lucide-react"
import { OnboardingWizard } from "./onboarding-wizard"
import { ReferralClaim } from "./referral-claim"
import { SignOutButton } from "./sign-out-button"
import { ThemeToggle } from "@/components/theme-toggle"
import { InvitationAcceptBridge } from "@/components/invitation-accept-bridge"
import { getOrCreateOnboardingState } from "@/lib/onboarding-state"
import { cookies } from "next/headers"
import { parsePlanIntent, planIntentPath, PLAN_INTENT_COOKIE } from "@/lib/plan-intent"
import { verifyOAuthOnboardingReturn } from "@/lib/oauth-onboarding-return"

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; oauth_return?: string }>
}) {
  const params = await searchParams
  const selectedPlan =
    parsePlanIntent(params.plan) ??
    parsePlanIntent((await cookies()).get(PLAN_INTENT_COOKIE)?.value)
  const session = await getSession()

  if (!session) {
    redirect("/sign-in")
  }

  // W2-05: an OAuth client (for example a coding agent) may send a
  // workspace-less user here to finish setup, with a signed return state bound
  // to the exact authorization request. The signature, expiry, and user
  // binding are verified server-side; an invalid state is dropped and the
  // wizard behaves exactly as a direct visit (no redirect, no error).
  const oauthReturn = params.oauth_return ? verifyOAuthOnboardingReturn(params.oauth_return) : null
  const oauthReturnQuery =
    oauthReturn && oauthReturn.valid && oauthReturn.userId === session.userId
      ? oauthReturn.oauthQuery
      : null

  let state = await getOrCreateOnboardingState(session.userId)

  if (state?.completed) {
    if (oauthReturnQuery) redirect(`/oauth/consent?${oauthReturnQuery}`)
    redirect(selectedPlan ? planIntentPath("/dashboard/billing", selectedPlan) : "/dashboard")
  }

  // W2-01: workspace naming is not part of the critical setup path. Reuse an
  // authorized active workspace when one exists. When none exists, the wizard
  // creates a default lazily — at the moment the user picks a target path —
  // so merely visiting onboarding (or skipping it) never creates a workspace
  // or trial the user did not ask for.
  let workspaceId = state.workspaceId
  if (workspaceId && !(await getWorkspaceMembership(workspaceId, session.userId))) {
    workspaceId = null
    state = await prisma.onboardingState.update({
      where: { userId: session.userId },
      data: { workspaceId: null, targetId: null, currentStep: 0 },
    })
  }
  if (!workspaceId) {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: session.userId, status: "active", workspace: { deletedAt: null } },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true },
    })
    if (memberships.length > 0) {
      workspaceId = memberships[0]!.workspaceId
      state = await prisma.onboardingState.update({
        where: { userId: session.userId },
        data: { workspaceId, currentStep: Math.max(state.currentStep, 1) },
      })
    }
  }

  const target =
    state.targetId && workspaceId
      ? await withWorkspaceRLS(workspaceId, (tx) =>
          tx.target.findFirst({
            where: { id: state.targetId!, workspaceId },
            select: { type: true, name: true },
          })
        )
      : null

  const initialState = {
    currentStep: state.workspaceId ? state.currentStep : Math.max(state.currentStep, 1),
    completed: state.completed,
    skipped: state.skipped,
    workspaceId,
    targetId: state.targetId,
    selectedGoal: state.selectedGoal,
    targetType: target?.type ?? null,
    targetName: target?.name ?? null,
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-8">
      <SignOutButton />
      <ThemeToggle className="absolute top-4 right-4 z-10" />
      <ReferralClaim />
      <div className="gradient-hero pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative mb-8 flex flex-col items-center">
        <div className="gradient-primary shadow-primary-glow mb-3 flex h-12 w-12 items-center justify-center rounded-xl">
          <ShieldCheck className="text-primary-foreground h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome to LyraShield</h1>
        <p className="text-muted-foreground text-sm">
          Let&apos;s get you set up for your first scan in under 5 minutes.
        </p>
      </div>

      <OnboardingWizard
        key={state.updatedAt.toISOString()}
        initialState={{ ...initialState, updatedAt: state.updatedAt.toISOString() }}
        selectedPlan={selectedPlan}
        suggestedWorkspaceName={
          session.userName?.trim() ? `${session.userName.trim()}'s workspace` : "My workspace"
        }
        oauthReturnQuery={oauthReturnQuery}
        oauthReturnState={oauthReturnQuery ? params.oauth_return : undefined}
      />
      <InvitationAcceptBridge />
    </div>
  )
}
