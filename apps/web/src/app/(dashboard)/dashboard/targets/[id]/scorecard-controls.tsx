"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@lyrashield/ui"
import { ScorecardShareComposer } from "../../../../../components/scorecard-share-composer"

type PublishedShare = {
  id: string
  slug: string
  url: string
  resolvedFindings: number
  views: number
  shareHandoffs: number
  referredSignups: number
}

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
  existingShare?: PublishedShare
}) {
  const [share, setShare] = useState(existingShare)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<"publish" | "revoke" | null>(null)
  const confirmationRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus()
  }, [confirmation])
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
      setShare(body.data as PublishedShare)
      setConfirmation(null)
      setNotice("Scorecard published. Choose a card and share it below.")
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

  return (
    <div className="mt-4 space-y-4">
      {confirmation ? (
        <div
          ref={confirmationRef}
          className="bg-muted/50 rounded-lg border p-3 text-sm"
          role="alertdialog"
          aria-modal="true"
          aria-label={
            confirmation === "publish"
              ? "Confirm scorecard publication"
              : "Confirm scorecard revocation"
          }
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) setConfirmation(null)
          }}
        >
          <p>
            {confirmation === "publish"
              ? `This publishes your ${grade.replace("_PLUS", "+")} grade. No target or vulnerability details are included.`
              : "Revoke this scorecard? Its public page, social cards, and badge will stop working."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void (confirmation === "publish" ? create(true) : revoke(true))}
              disabled={busy}
            >
              {busy ? "Working…" : confirmation === "publish" ? "Publish" : "Revoke"}
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
      ) : share ? (
        <>
          <div className="grid grid-cols-3 gap-2 text-center sm:max-w-md">
            {[
              ["Human views", share.views],
              ["Share handoffs", share.shareHandoffs],
              ["Referred signups", share.referredSignups],
            ].map(([label, value]) => (
              <div key={label} className="bg-muted/40 rounded-lg border p-3">
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-muted-foreground text-xs">{label}</p>
              </div>
            ))}
          </div>
          <ScorecardShareComposer
            slug={share.slug}
            url={share.url}
            grade={grade.replace("_PLUS", "+")}
            resolvedFindings={share.resolvedFindings}
            source="dashboard"
          />
          <Button size="sm" variant="ghost" onClick={() => void revoke()} disabled={busy}>
            Revoke public scorecard
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => void create()} disabled={busy}>
          {busy ? "Publishing…" : "Create public scorecard"}
        </Button>
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
