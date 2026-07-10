import { redirect } from "next/navigation"
import { Sidebar } from "@/components/sidebar"
import { getCachedSession, getCachedWorkspaces, getCachedOnboardingState, getCachedWorkspaceId } from "@/lib/cache"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
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
    <div className="flex min-h-screen">
      <Sidebar
        userName={session.userName}
        userEmail={session.userEmail}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
      <main className="flex-1 overflow-auto pt-16 md:pt-0">
        <div className="container mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  )
}
