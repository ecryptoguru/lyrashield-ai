"use client"

import { Select } from "@lyrashield/ui"
import { useId } from "react"

interface Workspace {
  id: string
  name: string
  slug: string
  mode: string
  plan: string
  role: string
}

export function WorkspaceSwitcher({
  workspaces,
  activeId,
  onSelect,
}: {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const selectId = useId()
  return (
    <div>
      <label htmlFor={selectId} className="sr-only">
        Active workspace
      </label>
      <Select
        id={selectId}
        value={activeId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        className="bg-sidebar hover:bg-sidebar-accent/50 border-0 shadow-none"
      >
        {!activeId && <option value="">Select workspace</option>}
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </Select>
    </div>
  )
}
