import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { Users } from "lucide-react"
import { TeamClient } from "./team-client"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"
import { NoWorkspaceState } from "@/components/no-workspace-state"
import { PageHeader } from "@/components/page-header"

export default async function TeamPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div>
        <PageHeader title="Team" description="Manage who has access to this workspace." />
        <NoWorkspaceState
          icon={Users}
          description="Create a workspace first to manage team members."
        />
      </div>
    )
  }

  const [members, invitations] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId, status: "active" },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: { workspaceId, status: "pending" },
      orderBy: { createdAt: "desc" },
    }),
  ])

  const userIds = members.map((m) => m.userId)
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, image: true },
  })

  const initialData = {
    members: members.map((m) => {
      const user = users.find((u) => u.id === m.userId)
      return {
        id: m.id,
        userId: m.userId,
        name: user?.name ?? "Unknown",
        email: user?.email ?? m.invitedEmail ?? "",
        image: user?.image ?? null,
        role: m.role,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      }
    }),
    invitations: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
  }

  return <TeamClient workspaceId={workspaceId} initialData={initialData} />
}
