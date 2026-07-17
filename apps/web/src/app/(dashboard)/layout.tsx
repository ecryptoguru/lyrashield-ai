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
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground fixed top-2 left-2 z-50 -translate-y-16 px-3 py-2 text-sm font-medium transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <main
        id="main-content"
        className="min-w-0 flex-1 overflow-x-hidden pt-16 md:pt-0"
        tabIndex={-1}
      >
        <div className="mx-auto w-full max-w-[92rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
