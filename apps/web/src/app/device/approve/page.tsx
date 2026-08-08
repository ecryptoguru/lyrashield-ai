"use client"

import { useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { authClient } from "@lyrashield/auth"

export default function DeviceApprovePage() {
  const userCode = useSearchParams().get("user_code") ?? ""
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [workspaceId, setWorkspaceId] = useState("")

  useEffect(() => {
    void fetch("/api/workspaces")
      .then(
        (response) => response.json() as Promise<{ data?: Array<{ id: string; name: string }> }>
      )
      .then((body) => {
        const items = body.data ?? []
        setWorkspaces(items)
        setWorkspaceId(items[0]?.id ?? "")
      })
      .catch(() => setMessage("Could not load your workspaces."))
  }, [])

  async function decide(approved: boolean) {
    setBusy(true)
    try {
      if (approved) {
        const active = await fetch("/api/workspaces/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        })
        if (!active.ok) throw new Error("Choose an available workspace before approving.")
      }
      const result = approved
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode })
      if (result.error)
        throw new Error(
          result.error.error_description ?? "The device request could not be updated."
        )
      setMessage(approved ? "Device approved. You can return to your CLI." : "Device denied.")
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "The device request could not be updated."
      )
      setBusy(false)
    }
  }

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <section className="bg-card w-full max-w-md rounded-2xl border p-6 shadow-sm">
        <p className="text-muted-foreground text-sm">LyraShield AI CLI connection</p>
        <h1 className="mt-2 text-2xl font-semibold">Approve this device?</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          The CLI will receive the scopes shown in its request and remain bound to the workspace you
          select during OAuth consent.
        </p>
        {message ? (
          <p className="mt-6 rounded-md border p-3 text-sm" role="status">
            {message}
          </p>
        ) : (
          <>
            <label className="mt-6 block text-sm font-medium" htmlFor="workspace">
              Workspace
            </label>
            <select
              id="workspace"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={busy || workspaces.length === 0}
              className="border-input bg-background mt-2 min-h-11 w-full rounded-md border px-3 text-sm"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => void decide(false)}
                disabled={busy}
                className="border-input min-h-11 flex-1 rounded-md border px-4 text-sm font-medium"
              >
                Deny
              </button>
              <button
                onClick={() => void decide(true)}
                disabled={busy || !workspaceId}
                className="bg-primary text-primary-foreground min-h-11 flex-1 rounded-md px-4 text-sm font-medium"
              >
                Approve
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  )
}
