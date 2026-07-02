import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { redirect } from "next/navigation"
import { ProjectsClient } from "./projects-client"

export default async function ProjectsPage() {
  const session = await getSession()
  if (!session) redirect("/sign-in")

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true },
  })

  const workspaceId = memberships[0]?.workspaceId

  if (!workspaceId) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <h2 className="mb-2 text-lg font-semibold">No workspace yet</h2>
        <p className="text-sm text-muted-foreground">
          Create a workspace first to start managing projects.
        </p>
      </div>
    )
  }

  return <ProjectsClient workspaceId={workspaceId} />
}
