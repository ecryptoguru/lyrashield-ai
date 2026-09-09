"use client"

import { useState } from "react"
import { AUTOMATION_WORKFLOWS, ScanModeSchema } from "@lyrashield/types"

type Workspace = { id: string; name: string }

export function OAuthConsentForm({
  clientName,
  clientId,
  scope,
  oauthQuery,
  consentState,
  workspaces,
}: {
  clientName: string
  scope: string
  oauthQuery?: string
  clientId: string
  consentState: string
  workspaces: Workspace[]
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canAutomate = scope.split(" ").includes("lyrashield.write")

  async function submit(accept: boolean) {
    setBusy(true)
    setError(null)
    let createdConnectionId: string | null = null
    try {
      if (accept) {
        if (!workspaceId) throw new Error("Choose a workspace before connecting.")
        const active = await fetch("/api/workspaces/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        })
        if (!active.ok) throw new Error("That workspace is no longer available.")

        {
          const ops = canAutomate ? AUTOMATION_WORKFLOWS.flatMap((wf) => [...wf.operations]) : []

          // The client identity sent to the API derives from the client id the
          // authorization request names — never a free-typed display string.
          // The server independently re-resolves both fields from the
          // registered OauthClient record, so a forged body cannot relabel
          // the connection either.
          const connRes = await fetch("/api/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              clientType: `oauth:${clientId}`,
              clientName,
              oauthClientId: clientId,
              scopes: canAutomate ? ["lyrashield.read", "lyrashield.write"] : ["lyrashield.read"],
              allowedOperations: ops,
              allowedTargetIds: [],
              allTargets: canAutomate,
              allowedProfiles: canAutomate ? ScanModeSchema.options : [],
              consentState,
            }),
          })
          if (!connRes.ok) {
            const errData = (await connRes.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            throw new Error(errData?.error?.message ?? "Failed to configure automated connection.")
          }
          const connData = (await connRes.json().catch(() => null)) as {
            data?: { id?: string }
          } | null
          createdConnectionId = typeof connData?.data?.id === "string" ? connData.data.id : null
        }
      }

      const acceptedScopes = scope
        .split(" ")
        .filter((requestedScope) => requestedScope !== "lyrashield.write" || canAutomate)
        .join(" ")
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, scope: acceptedScopes, oauth_query: oauthQuery }),
      })
      const body = (await response.json().catch(() => null)) as {
        redirect_uri?: string
        url?: string
      } | null
      const destination = body?.redirect_uri ?? body?.url
      if (!response.ok || !destination)
        throw new Error("The authorization request could not be completed.")
      window.location.assign(destination)
    } catch (cause) {
      // The connection must not outlive a failed consent: an ACTIVE grant whose
      // OAuth flow never completed would otherwise linger as a connected client.
      // The consent endpoint requires the connection to exist while it runs, so
      // the grant is created first and revoked here on every failure path.
      if (createdConnectionId) {
        await fetch(`/api/connections/${encodeURIComponent(createdConnectionId)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        }).catch(() => undefined)
      }
      setError(cause instanceof Error ? cause.message : "The authorization request failed.")
      setBusy(false)
    }
  }

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <section
        className="bg-card w-full max-w-xl rounded-2xl border p-6 shadow-sm sm:p-8"
        aria-labelledby="oauth-title"
      >
        <p className="text-muted-foreground text-sm font-medium">LyraShield AI Connection</p>
        <h1 id="oauth-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Connect {clientName}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm leading-6">
          Connect once to authorize this integration. Permitted actions run automatically without
          repeated review prompts.
        </p>

        {/* Workspace selection */}
        <label className="mt-6 block text-sm font-medium" htmlFor="workspace">
          Target Workspace
        </label>
        <select
          id="workspace"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          className="border-input bg-background mt-2 min-h-11 w-full rounded-md border px-3 text-sm"
          disabled={busy}
        >
          {workspaces.length === 0 ? <option value="">No active workspaces</option> : null}
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <section className="mt-6 rounded-lg border p-4" aria-label="Connection access">
          <h2 className="text-sm font-semibold">
            {canAutomate ? "Automatic workspace access" : "Read access"}
          </h2>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            {canAutomate
              ? "Connecting authorizes this integration to run scans and retests, save fix proposals, create reports, and open fix pull requests for all current and future targets in this workspace. Scans and retests can consume your included usage and incur charges under your workspace plan."
              : "This integration requested read access. It can inspect workspace evidence but cannot make changes."}
          </p>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            Your role, target authorization, plan limits, and budgets apply to every action. You can
            disconnect this integration at any time. Pull requests are never automatically merged.
          </p>
        </section>

        {error ? (
          <p className="text-destructive mt-4 text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => void submit(false)}
            disabled={busy}
            className="border-input min-h-11 rounded-md border px-4 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={busy || !workspaceId}
            className="bg-primary text-primary-foreground min-h-11 rounded-md px-4 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Connecting…" : "Connect LyraShield"}
          </button>
        </div>
      </section>
    </main>
  )
}
