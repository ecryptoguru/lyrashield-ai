"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { apiDelete } from "@/lib/api-client"
import { InlineConfirm } from "@/components/ui/inline-confirm"

export function DeleteTargetCard({
  targetId,
  workspaceId,
  targetName,
  targetCap,
  canDelete,
}: {
  targetId: string
  workspaceId: string
  targetName: string
  targetCap: number
  canDelete: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  if (!canDelete) return null

  const slotLine =
    targetCap > 0
      ? `This frees one of your ${targetCap} target slots.`
      : "This frees a target slot on your plan."

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      await apiDelete(
        `/api/targets/${encodeURIComponent(targetId)}?workspaceId=${encodeURIComponent(workspaceId)}`
      )
      router.push(`/dashboard/targets?deleted=${encodeURIComponent(targetName)}`)
    } catch (err) {
      setDeleting(false)
      setError(err instanceof Error ? err.message : "Failed to delete the target.")
    }
  }

  return (
    <div className="border-destructive/40 bg-card mb-6 rounded-xl border p-4 shadow-sm sm:p-6">
      <h2 className="text-destructive text-lg font-semibold">Delete {targetName}</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Deleting a target stops future scans and disables its schedules. Scans, findings, verdicts
        and reports stay in the workspace. {slotLine}
      </p>
      <div className="mt-4">
        <InlineConfirm
          triggerLabel={
            <>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete target
            </>
          }
          triggerVariant="destructive"
          aria-label={`Delete target ${targetName}`}
          message={`Delete ${targetName}? Scans, findings, verdicts and reports stay in the workspace. ${slotLine}`}
          confirmLabel="Delete"
          disabled={deleting}
          onConfirm={handleDelete}
        />
      </div>
      {error && (
        <p className="text-destructive mt-3 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
