import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { ShieldCheck } from "lucide-react"
import { OnboardingWizard } from "./onboarding-wizard"
import { ReferralClaim } from "./referral-claim"
import { SignOutButton } from "./sign-out-button"
import { ThemeToggle } from "@/components/theme-toggle"
import { InvitationAcceptBridge } from "@/components/invitation-accept-bridge"
import { getOrCreateOnboardingState } from "@/lib/onboarding-state"
import { withWorkspaceRLS } from "@lyrashield/db"
import { cookies } from "next/headers"
import { parsePlanIntent, planIntentPath, PLAN_INTENT_COOKIE } from "@/lib/plan-intent"

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>
}) {
  const params = await searchParams
  const selectedPlan =
    parsePlanIntent(params.plan) ??
    parsePlanIntent((await cookies()).get(PLAN_INTENT_COOKIE)?.value)
  const session = await getSession()

  if (!session) {
    redirect("/sign-in")
  }

  const state = await getOrCreateOnboardingState(session.userId)

  if (state?.completed) {
    redirect(selectedPlan ? planIntentPath("/dashboard/billing", selectedPlan) : "/dashboard")
  }

  const target =
    state.targetId && state.workspaceId
      ? await withWorkspaceRLS(state.workspaceId, (tx) =>
          tx.target.findFirst({
            where: { id: state.targetId!, workspaceId: state.workspaceId! },
            select: { type: true, name: true },
          })
        )
      : null

  const initialState = {
    currentStep: state.currentStep,
    completed: state.completed,
    skipped: state.skipped,
    workspaceId: state.workspaceId,
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

      <OnboardingWizard initialState={initialState} selectedPlan={selectedPlan} />
      <InvitationAcceptBridge />
    </div>
  )
}
