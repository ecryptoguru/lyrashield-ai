"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { Button, Input, FormField, Select } from "@lyrashield/ui"
import { apiGet, ApiError } from "@/lib/api-client"
import type { OnboardingWorkspaceChoice } from "@/lib/onboarding-workspace-schema"

export interface OnboardingWorkspaceOption {
  id: string
  name: string
  role: string
}
const optionsSchema = z.array(z.object({ id: z.string(), name: z.string(), role: z.string() }))

export function OnboardingWorkspaceChooser({
  choices,
  suggestedName,
  onChoose,
  onSkip,
  loading = false,
}: {
  choices: OnboardingWorkspaceOption[]
  suggestedName: string
  onChoose: (choice: OnboardingWorkspaceChoice) => Promise<string>
  onSkip: () => void
  loading?: boolean
}) {
  const router = useRouter()
  const [options, setOptions] = useState(choices)
  const [selection, setSelection] = useState(choices.length ? "" : "create")
  const [name, setName] = useState(suggestedName)
  const [submitting, setBusy] = useState(false)
  const busy = submitting || loading
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const available = selection === "create" || options.some((option) => option.id === selection)
  return (
    <section
      className="bg-card space-y-4 rounded-xl border p-5 sm:p-6"
      aria-labelledby="workspace-choice-title"
    >
      <h2 id="workspace-choice-title" className="text-lg font-semibold">
        Choose your workspace
      </h2>
      <p className="text-muted-foreground text-sm">
        Choose where to add your first target, or create a new workspace.
      </p>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy || !selection || !available) return
          setBusy(true)
          setError(null)
          setChanged(false)
          try {
            await onChoose(
              selection === "create"
                ? { kind: "create", name: name.trim() }
                : { kind: "select", workspaceId: selection }
            )
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
            if (cause instanceof ApiError && cause.code === "ONBOARDING_CHANGED") setChanged(true)
            if (cause instanceof ApiError && cause.code === "WORKSPACE_UNAVAILABLE") {
              try {
                setOptions(await apiGet("/api/onboarding/workspace", { schema: optionsSchema }))
              } catch {
                /* Keep the entered choice and the actionable server error. */
              }
            }
          } finally {
            setBusy(false)
          }
        }}
      >
        <FormField label="Workspace" htmlFor="onboarding-workspace">
          <Select
            id="onboarding-workspace"
            className="bg-background w-full min-w-0 rounded-md border px-3 py-2 text-sm"
            value={selection}
            disabled={busy}
            required
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="" disabled>
              Select a workspace
            </option>
            {!available && selection && (
              <option value={selection} disabled>
                Previously selected workspace unavailable
              </option>
            )}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} · {option.role.replaceAll("_", " ")}
              </option>
            ))}
            <option value="create">Create a new workspace</option>
          </Select>
        </FormField>
        {selection === "create" && (
          <FormField label="Workspace name" htmlFor="onboarding-workspace-name">
            <Input
              id="onboarding-workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              required
              maxLength={100}
              autoComplete="organization"
            />
          </FormField>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {changed && (
          <Button type="button" variant="outline" onClick={() => router.refresh()}>
            Reload setup
          </Button>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            disabled={busy || !selection || !available || (selection === "create" && !name.trim())}
          >
            {busy ? "Preparing workspace…" : "Use workspace"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onSkip}>
            Skip / finish later
          </Button>
        </div>
      </form>
    </section>
  )
}
