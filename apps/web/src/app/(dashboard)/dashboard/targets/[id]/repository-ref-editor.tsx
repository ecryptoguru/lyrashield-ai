"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button, Input } from "@lyrashield/ui"
import { apiPatch } from "@/lib/api-client"

export function RepositoryRefEditor({
  targetId,
  workspaceId,
  initialRef,
}: {
  targetId: string
  workspaceId: string
  initialRef: string
}) {
  const router = useRouter()
  const [currentRef, setCurrentRef] = useState(initialRef)
  const [ref, setRef] = useState(initialRef)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const trimmedRef = ref.trim()

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!trimmedRef || trimmedRef === currentRef) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await apiPatch(`/api/targets/${targetId}`, { workspaceId, branch: trimmedRef })
      setCurrentRef(trimmedRef)
      setRef(trimmedRef)
      setSaved(true)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update branch or tag")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-2">
      <label htmlFor="repository-ref" className="text-muted-foreground block text-sm">
        Branch or tag
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="repository-ref"
          value={ref}
          onChange={(event) => {
            setRef(event.target.value)
            setSaved(false)
          }}
          maxLength={255}
          aria-describedby="repository-ref-help repository-ref-status"
          required
        />
        <Button type="submit" disabled={saving || !trimmedRef || trimmedRef === currentRef}>
          {saving ? "Saving…" : "Save ref"}
        </Button>
      </div>
      <p id="repository-ref-help" className="text-muted-foreground text-xs">
        Set the exact branch or release tag before the first trust run. It becomes immutable after a
        run is created.
      </p>
      <p id="repository-ref-status" className="text-xs" aria-live="polite">
        {error ? <span className="text-destructive">{error}</span> : saved ? "Saved." : null}
      </p>
    </form>
  )
}
