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
  existingShare?: { id: string; slug: string; url: string }
}) {
  const [share, setShare] = useState(existingShare)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<"publish" | "revoke" | null>(null)
  if (!canPublish) return null

  const create = async (confirmed = false) => {
    if (["C", "D", "F"].includes(grade) && !confirmed) {
      setConfirmation("publish")
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/targets/${targetId}/scorecard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? "Could not create scorecard")
      const nextShare = { id: body.data.id, slug: body.data.slug, url: body.data.url }
      setShare(nextShare)
      setConfirmation(null)
      try {
        await navigator.clipboard.writeText(
          new URL(nextShare.url, window.location.origin).toString()
        )
        setNotice("Scorecard ready — share link copied.")
      } catch {
        setNotice("Scorecard ready. Open it below to copy the link.")
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create scorecard")
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (confirmed = false) => {
    if (!share) return
    if (!confirmed) {
      setConfirmation("revoke")
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/scorecards/${share.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      if (!response.ok) throw new Error("Could not revoke scorecard")
      setShare(undefined)
      setConfirmation(null)
      setNotice("Public scorecard revoked.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke scorecard")
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(new URL(share.url, window.location.origin).toString())
      setNotice("Share link copied.")
      setError(null)
    } catch {
      setError("Copy is unavailable in this browser. Open the scorecard and copy its URL.")
    }
  }

  return (
    <div className="mt-4 space-y-3">
      {confirmation && (
        <div className="bg-muted/50 rounded-lg border p-3 text-sm" role="status">
          <p>
            {confirmation === "publish"
              ? `This publishes your ${grade.replace("_PLUS", "+")} grade publicly. No vulnerability details are included.`
              : "Revoke this public scorecard? Its link and social preview will stop working."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void (confirmation === "publish" ? create(true) : revoke(true))}
              disabled={busy}
            >
              {busy
                ? "Working…"
                : confirmation === "publish"
                  ? "Publish scorecard"
                  : "Revoke scorecard"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmation(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!confirmation && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void (share ? revoke() : create())} disabled={busy}>
            {busy ? "Working…" : share ? "Revoke public scorecard" : "Create public scorecard"}
          </Button>
          {share && (
            <>
              <Button size="sm" variant="secondary" onClick={() => void copy()} disabled={busy}>
                Copy share link
              </Button>
              <a
                className="text-primary text-sm hover:underline"
                href={share.url}
                target="_blank"
                rel="noreferrer"
              >
                Open scorecard
              </a>
            </>
          )}
        </div>
      )}
      {notice && (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
