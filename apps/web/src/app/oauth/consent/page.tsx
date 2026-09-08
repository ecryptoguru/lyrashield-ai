import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { serializeOAuthQuery } from "../oauth-query"
import { createOAuthConsentState } from "@/lib/oauth-consent-state"
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

  // The connection grant is bound to THIS authorization request: the state is
  // minted server-side from the exact client_id and scope the client requested,
  // so POST /api/connections can reject a grant that does not match what the
  // user is actually consenting to.
  const requestedScopes =
    typeof params.scope === "string" && params.scope.trim().length > 0
      ? params.scope.trim().split(/\s+/)
      : ["lyrashield.read"]
  const consentState = createOAuthConsentState({
    clientId,
    scopes: requestedScopes,
    userId: session.userId,
  })

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.userId, status: "active" },
    select: { workspaceId: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  })

  return (
    <OAuthConsentForm
      clientName={typeof params.client_name === "string" ? params.client_name : "LyraShield AI"}
      clientId={clientId}
      scope={typeof params.scope === "string" ? params.scope : "lyrashield.read"}
      oauthQuery={oauthQuery}
      consentState={consentState}
      workspaces={memberships.map((membership) => ({
        id: membership.workspaceId,
        name: membership.workspace.name,
      }))}
    />
  )
}
