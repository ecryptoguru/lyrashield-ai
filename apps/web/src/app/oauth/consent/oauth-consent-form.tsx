"use client"

import { useState } from "react"
import { AUTOMATION_WORKFLOWS } from "@lyrashield/types"

type Workspace = { id: string; name: string }
type Target = { id: string; name: string; workspaceId: string; type: string }

export function OAuthConsentForm({
  clientName,
  clientId,
  scope,
  oauthQuery,
  workspaces,
  targets = [],
}: {
  clientName: string
  scope: string
  oauthQuery?: string
  clientId: string
  workspaces: Workspace[]
  targets?: Target[]
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [mode, setMode] = useState<"read_only" | "automate">("read_only")
  const [selectedWorkflows, setSelectedWorkflows] = useState<Set<string>>(new Set())
  const [allTargets, setAllTargets] = useState(false)
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set())
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const workspaceTargets = targets.filter((t) => t.workspaceId === workspaceId)
  const canAutomate = scope.split(" ").includes("lyrashield.write")

  function toggleWorkflow(id: string) {
    setSelectedWorkflows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleTarget(id: string) {
    setSelectedTargetIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleProfile(profile: string) {
    setSelectedProfiles((prev) => {
      const next = new Set(prev)
      if (next.has(profile)) next.delete(profile)
      else next.add(profile)
      return next
    })
  }

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

        if (mode === "automate" && selectedWorkflows.size === 0) {
          throw new Error("Select at least one workflow to automate.")
        }
        if (mode === "automate" && !allTargets && selectedTargetIds.size === 0) {
          throw new Error("Select at least one target or choose all targets.")
        }
        const selectedBillableWorkflow =
          selectedWorkflows.has("scans") || selectedWorkflows.has("retests")
        if (mode === "automate" && selectedBillableWorkflow && selectedProfiles.size === 0) {
          throw new Error("Select at least one scan profile for billable workflows.")
        }

        {
          const ops: string[] = []
          for (const wf of AUTOMATION_WORKFLOWS) {
            if (selectedWorkflows.has(wf.id)) {
              ops.push(...wf.operations)
            }
          }

          const connRes = await fetch("/api/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              clientType: clientName,
              clientName,
              oauthClientId: clientId,
              scopes:
                mode === "automate" ? ["lyrashield.read", "lyrashield.write"] : ["lyrashield.read"],
              allowedOperations: ops,
              allowedTargetIds:
                mode === "automate" && !allTargets ? Array.from(selectedTargetIds) : [],
              allTargets: mode === "automate" && allTargets,
              allowedProfiles: mode === "automate" ? Array.from(selectedProfiles) : [],
            }),
          })
          if (!connRes.ok) {
            const errData = (await connRes.json().catch(() => null)) as {
              error?: { message?: string }
            } | null
            throw new Error(errData?.error?.message ?? "Failed to configure automated connection.")
          }
        }
      }

      const acceptedScopes = scope
        .split(" ")
        .filter((requestedScope) => requestedScope !== "lyrashield.write" || mode === "automate")
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
        className="bg-card w-full max-w-xl rounded-2xl border p-6 shadow-sm sm:p-8"
        aria-labelledby="oauth-title"
      >
        <p className="text-muted-foreground text-sm font-medium">LyraShield AI Connection</p>
        <h1 id="oauth-title" className="mt-2 text-2xl font-semibold tracking-tight">
          Connect {clientName}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm leading-6">
          Connect once, explicitly authorize selected workflows for selected targets, and those
          workflows execute seamlessly without repeated approval prompts.
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

        {/* Authorization Mode */}
        <fieldset className="mt-6">
          <legend className="text-sm font-medium">Authorization Mode</legend>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer flex-col rounded-lg border p-4 text-sm transition-colors ${
                mode === "read_only"
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-input bg-background text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="auth_mode"
                  value="read_only"
                  checked={mode === "read_only"}
                  onChange={() => setMode("read_only")}
                  disabled={busy}
                  className="size-4"
                />
                <span className="font-semibold text-foreground">Read only</span>
              </div>
              <span className="mt-2 text-xs leading-5">
                Inspect findings, reports, and scan status. Mutating tools are not automated.
              </span>
            </label>

            <label
              className={`flex cursor-pointer flex-col rounded-lg border p-4 text-sm transition-colors ${
                mode === "automate"
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-input bg-background text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="auth_mode"
                  value="automate"
                  checked={mode === "automate"}
                  onChange={() => setMode("automate")}
                  disabled={busy || !canAutomate}
                  className="size-4"
                />
                <span className="font-semibold text-foreground">Automate selected workflows</span>
              </div>
              <span className="mt-2 text-xs leading-5">
                {canAutomate
                  ? "Execute approved actions seamlessly within delegated permissions and budgets."
                  : "This client requested read access only. Reconnect with write scope to automate workflows."}
              </span>
            </label>
          </div>
        </fieldset>

        {/* Expanded Workflow Selection if Automate Mode */}
        {mode === "automate" && (
          <div className="mt-6 rounded-lg border p-4 bg-muted/20">
            <h3 className="text-sm font-medium text-foreground">Automated Workflows</h3>
            <p className="text-muted-foreground text-xs mt-1">
              Select which actions this connection may execute without prompt:
            </p>
            <div className="mt-3 space-y-3">
              {AUTOMATION_WORKFLOWS.map((wf) => (
                <label key={wf.id} className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedWorkflows.has(wf.id)}
                    onChange={() => toggleWorkflow(wf.id)}
                    disabled={busy}
                    className="mt-0.5 size-4 rounded"
                  />
                  <div>
                    <span className="font-medium text-foreground">{wf.label}</span>
                    <span className="text-muted-foreground block text-xs mt-0.5">
                      {wf.description}
                    </span>
                  </div>
                </label>
              ))}
            </div>

            {/* Target scoping */}
            <div className="mt-5 border-t pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Target Scope
              </h4>
              <div className="mt-2 space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="target_scope"
                    checked={allTargets}
                    onChange={() => setAllTargets(true)}
                    disabled={busy}
                    className="size-4"
                  />
                  <span>All current and future targets in workspace</span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="target_scope"
                    checked={!allTargets}
                    onChange={() => setAllTargets(false)}
                    disabled={busy}
                    className="size-4"
                  />
                  <span>Selected targets only</span>
                </label>
              </div>

              {!allTargets && workspaceTargets.length > 0 && (
                <div className="mt-3 ml-6 space-y-2 border-l pl-3">
                  {workspaceTargets.map((target) => (
                    <label
                      key={target.id}
                      className="flex items-center gap-2 text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTargetIds.has(target.id)}
                        onChange={() => toggleTarget(target.id)}
                        disabled={busy}
                        className="size-3.5"
                      />
                      <span>
                        {target.name} ({target.type})
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {!allTargets && workspaceTargets.length === 0 ? (
                <p className="text-muted-foreground mt-3 text-xs" role="status">
                  This workspace has no targets yet. Add a target first or authorize all future
                  targets.
                </p>
              ) : null}
            </div>

            {(selectedWorkflows.has("scans") || selectedWorkflows.has("retests")) && (
              <div className="mt-5 border-t pt-4">
                <h4 className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                  Allowed scan profiles
                </h4>
                <p className="text-muted-foreground mt-1 text-xs">
                  Profile limits and workspace budgets still apply to every run.
                </p>
                <div className="mt-3 flex flex-wrap gap-4">
                  {["SAFE", "QUICK", "STANDARD"].map((profile) => (
                    <label key={profile} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedProfiles.has(profile)}
                        onChange={() => toggleProfile(profile)}
                        disabled={busy}
                        className="size-4 rounded"
                      />
                      <span>{profile.charAt(0) + profile.slice(1).toLowerCase()}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

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
