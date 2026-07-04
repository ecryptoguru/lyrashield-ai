import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { Sidebar } from "@/components/sidebar"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()

  if (!session) {
    redirect("/sign-in")
  }

  const onboardingState = await prisma.onboardingState.findUnique({
    where: { userId: session.userId },
  })

  if (onboardingState && !onboardingState.completed && !onboardingState.skipped) {
    redirect("/onboarding")
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    include: { workspace: true },
  })

  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    mode: m.workspace.mode,
    plan: m.workspace.plan,
    role: m.role,
  }))

  return (
    <div className="flex min-h-screen">
      <Sidebar
        userName={session.userName}
        userEmail={session.userEmail}
        workspaces={workspaces}
      />
      <main className="flex-1 overflow-auto">
        <div className="container mx-auto p-6">{children}</div>
      </main>
    </div>
  )
}
