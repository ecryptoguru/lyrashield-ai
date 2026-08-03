"use client"

import { useState } from "react"
import Link from "next/link"
import { Trash2 } from "lucide-react"
import { Button, FormField, Input, buttonVariants } from "@lyrashield/ui"
import { apiDelete, ApiError } from "@/lib/api-client"

interface DeletionPlan {
  deletable: Array<{ id: string; name: string }>
  blocked: Array<{
    id: string
    name: string
    members: Array<{ id: string; name: string | null; email: string }>
  }>
  retained: Array<{ id: string; name: string }>
}

interface DeleteAccountProps {
  plan: DeletionPlan
}

export function DeleteAccount({ plan }: DeleteAccountProps) {
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState("")
  const [deleting, setDeleting] = useState(false)

  const isBlocked = plan.blocked.length > 0
  const deletableNames = plan.deletable.map((workspace) => workspace.name).sort()
  const expectedConfirmation = deletableNames.length > 0 ? deletableNames.join(", ") : "DELETE"
  const hasDeletable = deletableNames.length > 0

  function description() {
    if (isBlocked) {
      return "You are the sole owner of a workspace with other active members. Promote another member to owner before deleting your account."
    }
    if (hasDeletable) {
      if (deletableNames.length === 1) {
        return `This will permanently delete your account and the workspace "${deletableNames[0]}", including its scans, findings, reports and audit logs. This cannot be undone.`
      }
      return `This will permanently delete your account and the following workspaces: ${deletableNames.join(", ")}. Their scans, findings, reports and audit logs will also be destroyed.`
    }
    return "Your login and memberships will be removed. Historical security records retain anonymous attribution."
  }

  async function deleteAccount() {
    setDeleting(true)
    setError("")
    try {
      await apiDelete("/api/account", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      })
      window.location.assign("/sign-in")
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError("Failed to delete account")
      }
      setDeleting(false)
    }
  }

  if (isBlocked) {
    return (
      <div className="border-destructive/40 space-y-4 border-t pt-6">
        <h2 className="font-semibold">Delete account</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description()}</p>
        {plan.blocked.map((workspace) => (
          <div key={workspace.id} className="text-muted-foreground text-sm">
            <p className="font-medium">{workspace.name}</p>
            {workspace.members.length > 0 ? (
              <p>
                Members who can be promoted:{" "}
                {workspace.members.map((member) => member.name ?? member.email).join(", ")}
              </p>
            ) : null}
          </div>
        ))}
        <Link
          href="/dashboard/team"
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          Go to Team settings
        </Link>
      </div>
    )
  }

  return (
    <div className="border-destructive/40 space-y-4 border-t pt-6">
      <div>
        <h2 className="font-semibold">Delete account</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description()}</p>
      </div>
      <div className="max-w-sm">
        <FormField
          label={`Type "${expectedConfirmation}" to confirm`}
          htmlFor="delete-confirmation"
        >
          <Input
            id="delete-confirmation"
            name="delete-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "delete-account-error" : undefined}
          />
        </FormField>
        {error ? (
          <p id="delete-account-error" className="text-destructive mt-1 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        variant="destructive"
        disabled={confirmation !== expectedConfirmation || deleting}
        onClick={deleteAccount}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {deleting ? "Deleting..." : "Delete account"}
      </Button>
    </div>
  )
}
