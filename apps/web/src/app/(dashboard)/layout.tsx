import { redirect } from "next/navigation"
import { V2Sidebar } from "@/components/v2-sidebar"
import { BottomNav } from "@/components/bottom-nav"
import { MobilePageHeader } from "@/components/mobile-page-header"
import {
  getCachedSession,
  getCachedWorkspaces,
  getCachedOnboardingState,
  getCachedWorkspaceId,
  getCachedUnreadNotifications,
  getCachedPendingApprovals,
} from "@/lib/cache"
import type { MemberRole } from "@lyrashield/db"

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

  const active = activeWorkspaceId ? workspaces.find((w) => w.id === activeWorkspaceId) : null

  const [unreadNotifications, pendingApprovals] = await Promise.all([
    activeWorkspaceId
      ? getCachedUnreadNotifications(session.userId, activeWorkspaceId)
      : Promise.resolve(0),
    // The Review Queue badge is authorization-sensitive: only members with
    // agent:view may see that pending approvals exist. The count is
    // workspace-scoped, cached per request, and never surfaced for
    // unauthorized roles.
    active && activeWorkspaceId
      ? getCachedPendingApprovals(activeWorkspaceId, active.role as MemberRole)
      : Promise.resolve(0),
  ])

  return (
    <div className="bg-background flex min-h-screen flex-col md:flex-row">
      <V2Sidebar
        userName={session.userName}
        userEmail={session.userEmail}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        pendingApprovals={pendingApprovals}
      />
      {/* Title derives from the current route via NAV_ITEMS. On a phone the header
            is the only place a screen can be named, so it must not spend that slot
            on the brand. */}
      <MobilePageHeader />
      <nav aria-label="Skip navigation">
        <a
          href="#main-content"
          className="bg-primary text-primary-foreground fixed top-2 left-2 z-50 -translate-y-16 rounded-lg px-3 py-2 text-sm font-medium transition-transform focus:translate-y-0"
        >
          Skip to content
        </a>
      </nav>
      <main
        id="main-content"
        className="min-w-0 flex-1 overflow-x-hidden pt-[calc(4rem+env(safe-area-inset-top))] md:pt-0"
        tabIndex={-1}
      >
        <div className="mx-auto w-full max-w-368 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
      <BottomNav unreadNotifications={unreadNotifications} pendingApprovals={pendingApprovals} />
    </div>
  )
}
