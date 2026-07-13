import { redirect } from "next/navigation"
import { Sidebar } from "@/components/sidebar"
import {
  getCachedSession,
  getCachedWorkspaces,
  getCachedOnboardingState,
  getCachedWorkspaceId,
} from "@/lib/cache"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCachedSession()

  if (!session) {
    redirect("/sign-in")
  }

  const [onboardingState, workspaces, activeWorkspaceId] = await Promise.all([
    getCachedOnboardingState(session.userId),
    getCachedWorkspaces(session.userId),
    getCachedWorkspaceId(session.userId),
  ])

  if (onboardingState && !onboardingState.completed && !onboardingState.skipped) {
    redirect("/onboarding")
  }

  return (
    <div className="bg-background flex min-h-screen">
      <Sidebar
        userName={session.userName}
        userEmail={session.userEmail}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
      <main className="min-w-0 flex-1 overflow-x-hidden pt-16 md:pt-0">
        <div className="mx-auto w-full max-w-[92rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
