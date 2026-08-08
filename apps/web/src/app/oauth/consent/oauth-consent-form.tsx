"use client"

import { useState } from "react"

type Workspace = { id: string; name: string }

export function OAuthConsentForm({
  clientName,
  scope,
  oauthQuery,
  workspaces,
}: {
  clientName: string
  scope: string
  oauthQuery?: string
  workspaces: Workspace[]
}) {
  const requested = new Set(scope.split(" ").filter(Boolean))
  const [write, setWrite] = useState(requested.has("lyrashield.write"))
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(accept: boolean) {
    setBusy(true)
    setError(null)
    try {
      if (accept) {
        if (!workspaceId) throw new Error("Choose a workspace before connecting.")
        const active = await fetch("/api/workspaces/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        })
        if (!active.ok) throw new Error("That workspace is no longer available.")
      }

      const acceptedScopes = scope
        .split(" ")
        .filter((requestedScope) => requestedScope !== "lyrashield.write" || write)
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
      setError(cause instanceof Error ? cause.message : "The authorization request failed.")
      setBusy(false)
    }
  }

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <section
        className="bg-card w-full max-w-lg rounded-2xl border p-6 shadow-sm sm:p-8"
        aria-labelledby="oauth-title"
      >
        <p className="text-muted-foreground text-sm">LyraShield AI connection</p>
        <h1 id="oauth-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Connect {clientName}
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          This connection starts read-only. You can enable write actions only when you need them;
          every write still waits for LyraShield approval.
        </p>

        <label className="mt-6 block text-sm font-medium" htmlFor="workspace">
          Workspace
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

        {requested.has("lyrashield.write") ? (
          <label className="mt-5 flex items-start gap-3 rounded-lg border p-3 text-sm">
            <input
              type="checkbox"
              checked={write}
              onChange={(event) => setWrite(event.target.checked)}
              disabled={busy}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">Allow write actions</span>
              <span className="text-muted-foreground mt-1 block leading-5">
                The agent may request scans, reports, or fixes. LyraShield will still ask you to
                approve each mutating action.
              </span>
            </span>
          </label>
        ) : null}

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
