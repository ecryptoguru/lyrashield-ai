import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { TeamClient } from "./team-client"
import { getCachedSession, getCachedWorkspaceId } from "@/lib/cache"

export default async function TeamPage() {
  const session = await getCachedSession()
  if (!session) redirect("/sign-in")

  const workspaceId = await getCachedWorkspaceId(session.userId)

  if (!workspaceId) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
        <p className="text-sm text-muted-foreground">
          Create a workspace first to manage team members.
        </p>
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
