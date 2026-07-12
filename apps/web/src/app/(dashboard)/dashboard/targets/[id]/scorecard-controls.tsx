"use client"

import { useState } from "react"
import { Button } from "@lyrashield/ui"

export function ScorecardControls({
  targetId,
  workspaceId,
  grade,
  canPublish,
  existingShare,
}: {
  targetId: string
  workspaceId: string
  grade: string
  canPublish: boolean
  existingShare?: { id: string; slug: string }
}) {
  const [share, setShare] = useState(existingShare)
  const [error, setError] = useState<string | null>(null)
  if (!canPublish) return null
  const create = async () => {
    if (
      ["C", "D", "F"].includes(grade) &&
      !window.confirm("You are publishing a below-average grade. Continue?")
    )
      return
    const response = await fetch(`/api/targets/${targetId}/scorecard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    })
    const body = await response.json()
    if (!response.ok) return setError(body.error?.message ?? "Could not create scorecard")
    setShare({ id: body.data.id, slug: body.data.slug })
    await navigator.clipboard?.writeText(new URL(body.data.url, window.location.origin).toString())
  }
  const revoke = async () => {
    if (!share) return
    const response = await fetch(`/api/scorecards/${share.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    })
    if (!response.ok) return setError("Could not revoke scorecard")
    setShare(undefined)
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={share ? revoke : create}>
        {share ? "Revoke public scorecard" : "Create public scorecard"}
      </Button>
      {share && (
        <a
          className="text-primary text-sm hover:underline"
          href={`/score/${share.slug}`}
          target="_blank"
          rel="noreferrer"
        >
          Open scorecard
        </a>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
