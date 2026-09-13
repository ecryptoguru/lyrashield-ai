"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@lyrashield/ui"
import { InlineConfirm } from "@/components/ui/inline-confirm"

export function ConnectionActions({
  id,
  workspaceId,
  status,
  clientName,
}: {
  id: string
  workspaceId: string
  status: string
  clientName?: string | null
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function update(action: "resume" | "revoke") {
    setPending(true)
    setError(null)
    try {
      const response = await fetch(`/api/connections/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      if (!response.ok) throw new Error("Connection could not be updated. Please retry.")
      router.refresh()
    } catch {
      setError("Connection could not be updated. Please retry.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "PAUSED" && (
          <Button size="sm" disabled={pending} onClick={() => void update("resume")}>
            Resume
          </Button>
        )}
        {status !== "REVOKED" && (
          <InlineConfirm
            triggerLabel={pending ? "Updating…" : "Disconnect"}
            triggerVariant="outline"
            confirmLabel="Disconnect"
            disabled={pending}
            message={`Disconnect ${clientName ?? "this client"}? The coding agent must reconnect before it can act in this workspace again.`}
            onConfirm={() => void update("revoke")}
          />
        )}
      </div>
      {(status === "REVOKED" || status === "EXPIRED") && (
        <p className="text-muted-foreground text-xs">
          Reconnect from your coding agent’s LyraShield connection settings to sign in again.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  )
}
