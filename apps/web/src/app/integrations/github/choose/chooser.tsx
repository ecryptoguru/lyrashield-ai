"use client"

import { useState } from "react"
import Link from "next/link"
import { Button, Select } from "@lyrashield/ui"
import { apiPost } from "@/lib/api-client"
import { installUrlSchema } from "@/lib/api-schemas"

export function GitHubInstallationChooser({
  state,
  workspaceId,
  candidates,
  returnPath,
}: {
  state: string
  workspaceId: string
  candidates: { id: number; login: string }[]
  returnPath: string
}) {
  const [selected, setSelected] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await apiPost(
        "/api/integrations/github/install",
        { workspaceId, chooserState: state, selectedId: Number(selected) },
        { schema: installUrlSchema }
      )
      window.location.assign(result.installUrl)
    } catch {
      setError(
        "Could not continue. Retry or cancel and start a new connection if your session expired."
      )
      setBusy(false)
    }
  }
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">Choose a GitHub installation</h1>
      <p className="text-muted-foreground">
        Choose the account to connect to this workspace. GitHub will confirm your access again
        before connecting.
      </p>
      <form className="space-y-4" onSubmit={submit}>
        <label className="block space-y-2">
          <span>GitHub account</span>
          <Select
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
            required
          >
            <option value="">Select an account</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.login}
              </option>
            ))}
          </Select>
        </label>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={!selected || busy} aria-busy={busy}>
            {busy ? "Continuing…" : "Continue with GitHub"}
          </Button>
          <Link href={returnPath} className="underline">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  )
}
