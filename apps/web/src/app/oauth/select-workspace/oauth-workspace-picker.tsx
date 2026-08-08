"use client"

import { useState } from "react"

export function OAuthWorkspacePicker({
  oauthQuery,
  workspaces,
}: {
  oauthQuery?: string
  workspaces: Array<{ id: string; name: string }>
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function continueAuthorization() {
    setBusy(true)
    setError(null)
    try {
      const active = await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      if (!active.ok) throw new Error("That workspace is no longer available.")
      const response = await fetch("/api/auth/oauth2/continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postLogin: true, oauth_query: oauthQuery }),
      })
      const body = (await response.json().catch(() => null)) as {
        redirect_uri?: string
        url?: string
      } | null
      const destination = body?.redirect_uri ?? body?.url
      if (!response.ok || !destination)
        throw new Error("The workspace selection could not be completed.")
      window.location.assign(destination)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace selection failed.")
      setBusy(false)
    }
  }

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <section
        className="bg-card w-full max-w-lg rounded-2xl border p-6 shadow-sm sm:p-8"
        aria-labelledby="workspace-title"
      >
        <p className="text-muted-foreground text-sm">LyraShield AI connection</p>
        <h1 id="workspace-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Choose a workspace
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          This agent connection will be limited to the workspace you select.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="workspace">
          Workspace
        </label>
        <select
          id="workspace"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          disabled={busy}
          className="border-input bg-background mt-2 min-h-11 w-full rounded-md border px-3 text-sm"
        >
          {workspaces.length === 0 ? <option value="">No active workspaces</option> : null}
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        {error ? (
          <p className="text-destructive mt-4 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void continueAuthorization()}
          disabled={busy || !workspaceId}
          className="bg-primary text-primary-foreground mt-7 min-h-11 w-full rounded-md px-4 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Continuing…" : "Continue"}
        </button>
      </section>
    </main>
  )
}
