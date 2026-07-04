import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { ShieldCheck } from "lucide-react"
import { OnboardingWizard } from "./onboarding-wizard"

export default async function OnboardingPage() {
  const session = await getSession()

  if (!session) {
    redirect("/sign-in")
  }

  let state = await prisma.onboardingState.findUnique({
    where: { userId: session.userId },
  })

  if (state?.completed) {
    redirect("/dashboard")
  }

  if (!state) {
    state = await prisma.onboardingState.create({
      data: { userId: session.userId },
    })
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-8">
      <div className="mb-8 flex flex-col items-center">
        <ShieldCheck className="mb-2 h-10 w-10 text-primary" />
        <h1 className="text-2xl font-bold">Welcome to LyraShield</h1>
        <p className="text-sm text-muted-foreground">
          Let&apos;s get you set up for your first scan in under 5 minutes.
        </p>
      </div>

      <OnboardingWizard
        initialState={{
          currentStep: state.currentStep,
          completed: state.completed,
          skipped: state.skipped,
          workspaceId: state.workspaceId,
          targetId: state.targetId,
          selectedGoal: state.selectedGoal,
        }}
      />
    </div>
  )
}
