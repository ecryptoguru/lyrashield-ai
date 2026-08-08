import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { OAuthWorkspacePicker } from "./oauth-workspace-picker"

export const dynamic = "force-dynamic"

export default async function OAuthWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  if (!session) redirect("/sign-in")
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })
  return (
    <OAuthWorkspacePicker
      oauthQuery={typeof params.oauth_query === "string" ? params.oauth_query : undefined}
      workspaces={memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
      }))}
    />
  )
}
