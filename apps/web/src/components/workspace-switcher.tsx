"use client"

import { useState, useEffect, useRef } from "react"
import { ChevronDown, Check } from "lucide-react"

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const active = workspaces.find((w) => w.id === activeId)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className="hover:bg-sidebar-accent/50 flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors"
      >
        <span className="truncate">{active?.name ?? "Select workspace"}</span>
        <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div className="bg-popover absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border p-1 shadow-md">
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                onSelect(w.id)
                setOpen(false)
              }}
              className="hover:bg-accent flex min-h-11 w-full items-center justify-between rounded-lg px-2 text-sm transition-colors"
              aria-current={w.id === activeId ? "true" : undefined}
            >
              <span className="truncate">{w.name}</span>
              {w.id === activeId && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
