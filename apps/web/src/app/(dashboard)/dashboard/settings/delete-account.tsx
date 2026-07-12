"use client"

import { useState } from "react"
import { Trash2 } from "lucide-react"
import { Button, FormField, Input } from "@lyrashield/ui"
import { apiDelete, ApiError } from "@/lib/api-client"

export function DeleteAccount() {
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState("")
  const [deleting, setDeleting] = useState(false)

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
      setError(err instanceof ApiError ? err.message : "Failed to delete account")
      setDeleting(false)
    }
  }

  return (
    <div className="border-destructive/40 space-y-4 border-t pt-6">
      <div>
        <h2 className="font-semibold">Delete account</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your login and memberships will be removed. Historical security records retain anonymous
          attribution.
        </p>
      </div>
      <div className="max-w-sm">
        <FormField label='Type "DELETE" to confirm' htmlFor="delete-confirmation">
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
        disabled={confirmation !== "DELETE" || deleting}
        onClick={deleteAccount}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {deleting ? "Deleting..." : "Delete account"}
      </Button>
    </div>
  )
}
