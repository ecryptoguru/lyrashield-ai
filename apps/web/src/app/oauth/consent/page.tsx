import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { serializeOAuthQuery } from "../oauth-query"
import { OAuthConsentForm } from "./oauth-consent-form"

export const dynamic = "force-dynamic"

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const session = await getSession()
  const oauthQuery = serializeOAuthQuery(params)
  const clientId = typeof params.client_id === "string" ? params.client_id : ""
  if (!session)
    redirect(`/sign-in?callbackURL=${encodeURIComponent(`/oauth/consent?${oauthQuery}`)}`)
  if (!clientId) redirect("/sign-in?error=invalid_oauth_request")

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })

  const workspaceIds = memberships.map((m) => m.workspaceId)
  const targets = (
    await Promise.all(
      workspaceIds.map((workspaceId) =>
        withWorkspaceRLS(workspaceId, (tx) =>
          tx.target.findMany({
            where: { workspaceId, deletedAt: null },
            select: { id: true, name: true, workspaceId: true, type: true },
            orderBy: { name: "asc" },
          })
        )
      )
    )
  ).flat()

  return (
    <OAuthConsentForm
      clientName={typeof params.client_name === "string" ? params.client_name : "LyraShield AI"}
      clientId={clientId}
      scope={typeof params.scope === "string" ? params.scope : "lyrashield.read"}
      oauthQuery={oauthQuery}
      workspaces={memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
      }))}
      targets={targets}
    />
  )
}
