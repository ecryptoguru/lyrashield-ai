"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button, Select } from "@lyrashield/ui"
import { apiPatch } from "@/lib/api-client"

export interface EligibleGitHubConnection {
  installationId: string
  name: string
}

/**
 * Rebinds a repository target to a GitHub connection the workspace owns. The
 * server revalidates the installation and its access to the exact repository;
 * this control only chooses which connection to try.
 */
export function RepositoryConnectionRecovery({
  targetId,
  workspaceId,
  currentInstallationId,
  connections,
}: {
  targetId: string
  workspaceId: string
  currentInstallationId: string | null
  connections: EligibleGitHubConnection[]
}) {
  const router = useRouter()
  // A target whose recorded installation is gone must not preselect a dead id:
  // fall back to an eligible connection so the action is immediately usable.
  const [selected, setSelected] = useState(
    connections.find((connection) => connection.installationId === currentInstallationId)
      ?.installationId ??
      connections[0]?.installationId ??
      ""
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (connections.length === 0) {
    return (
      <div className="mt-4 border-t pt-4 text-sm">
        <p className="text-muted-foreground">
          This repository is not bound to a GitHub connection, so scans cannot fetch it. Connect
          GitHub to this workspace, then return here to bind it.
        </p>
        <Link
          href="/dashboard/integrations"
          className="text-primary mt-2 inline-block text-sm font-medium hover:underline"
        >
          Connect GitHub
        </Link>
      </div>
    )
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || selected === currentInstallationId) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await apiPatch(`/api/targets/${targetId}`, { workspaceId, installationId: selected })
      setSaved(true)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to use this connection")
    } finally {
      setSaving(false)
    }
  }

  const unchanged = !selected || selected === currentInstallationId
  return (
    <form onSubmit={save} className="mt-4 space-y-2 border-t pt-4">
      <label htmlFor="target-github-connection" className="text-muted-foreground block text-sm">
        GitHub connection
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          id="target-github-connection"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value)
            setSaved(false)
            setError(null)
          }}
          aria-describedby="target-github-connection-help target-github-connection-status"
        >
          {connections.map((connection) => (
            <option key={connection.installationId} value={connection.installationId}>
              {connection.name}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={saving || unchanged}>
          {saving ? "Rebinding…" : "Use this connection"}
        </Button>
      </div>
      <p id="target-github-connection-help" className="text-muted-foreground text-xs">
        Scans use this connection to fetch the repository. The revision recorded by each scan stays
        immutable.
      </p>
      <p id="target-github-connection-status" className="text-xs" aria-live="polite">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : saved ? (
          "Connection updated."
        ) : null}
      </p>
    </form>
  )
}
