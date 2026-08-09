import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { serializeOAuthQuery } from "../oauth-query"
import { OAuthWorkspacePicker } from "./oauth-workspace-picker"

export const dynamic = "force-dynamic"

export default async function OAuthWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  const oauthQuery = serializeOAuthQuery(params)
  if (!session) redirect("/sign-in")
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })
  return (
    <OAuthWorkspacePicker
      oauthQuery={oauthQuery}
      workspaces={memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
      }))}
    />
  )
}
