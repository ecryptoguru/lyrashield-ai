import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
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
  if (!session)
    redirect(`/sign-in?callbackURL=${encodeURIComponent(`/oauth/consent?${oauthQuery}`)}`)

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })

  return (
    <OAuthConsentForm
      clientName={typeof params.client_name === "string" ? params.client_name : "LyraShield AI"}
      scope={typeof params.scope === "string" ? params.scope : "lyrashield.read"}
      oauthQuery={oauthQuery}
      workspaces={memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
      }))}
    />
  )
}
