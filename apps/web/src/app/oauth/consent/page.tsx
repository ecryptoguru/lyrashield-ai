import { redirect } from "next/navigation"
import { getSession } from "@lyrashield/auth/server"
import { prisma } from "@lyrashield/db"
import { serializeOAuthQuery } from "../oauth-query"
import { createOAuthConsentState } from "@/lib/oauth-consent-state"
import { createOAuthOnboardingReturn } from "@/lib/oauth-onboarding-return"
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

  // W3-08 (Deep Review v16 item 1.5): the display name NEVER comes from the
  // query string — a registered client could present itself under any
  // product name. Resolve it server-side from the OauthClient record by the
  // client id the authorization request actually names.
  const oauthClient = await prisma.oauthClient.findFirst({
    where: { clientId, disabled: { not: true } },
    select: { name: true, uri: true },
  })
  const resolvedClientName = oauthClient?.name?.trim() || clientId

  // W2-05: a user arriving from an OAuth client with no workspace cannot
  // consent yet. Send them through onboarding with a signed, expiring return
  // state bound to this exact authorization request; onboarding returns them
  // here (fixed /oauth/consent destination — no open redirect).
  if (memberships.length === 0) {
    const returnState = createOAuthOnboardingReturn(oauthQuery, session.userId)
    redirect(`/onboarding?oauth_return=${encodeURIComponent(returnState)}`)
  }

  return (
    <OAuthConsentForm
      clientName={resolvedClientName}
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
