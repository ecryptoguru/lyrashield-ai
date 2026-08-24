"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { Button } from "@lyrashield/ui"

export type DashboardExperienceMode = "guided" | "pro"

export function parseDashboardExperience(value: string | null): DashboardExperienceMode {
  return value === "pro" ? "pro" : "guided"
}

export function dashboardExperienceStorageKey(workspaceId: string): string {
  return `lyrashield-dashboard-experience:${workspaceId}`
}

const DashboardExperienceContext = createContext<{
  mode: DashboardExperienceMode
  setMode: (mode: DashboardExperienceMode) => void
}>({ mode: "guided", setMode: () => undefined })

export function DashboardExperience({
  workspaceId,
  children,
}: {
  workspaceId: string
  children: React.ReactNode
}) {
  const storageKey = dashboardExperienceStorageKey(workspaceId)
  const [mode, setMode] = useState<DashboardExperienceMode>("guided")

  useEffect(() => {
    let cancelled = false
    const restore = () => {
      if (cancelled) return
      try {
        setMode(parseDashboardExperience(window.localStorage.getItem(storageKey)))
      } catch {
        // Storage can be disabled; Guided is the safe, fully functional default.
      }
    }
    queueMicrotask(restore)
    return () => {
      cancelled = true
    }
  }, [storageKey])

  function selectMode(nextMode: DashboardExperienceMode) {
    setMode(nextMode)
    try {
      window.localStorage.setItem(storageKey, nextMode)
    } catch {
      // Keep the selection for this page even when persistence is unavailable.
    }
  }

  return (
    <DashboardExperienceContext.Provider value={{ mode, setMode: selectMode }}>
      {children}
    </DashboardExperienceContext.Provider>
  )
}

export function DashboardExperienceControl() {
  const { mode, setMode } = useContext(DashboardExperienceContext)

  return (
    <div className="bg-muted flex rounded-lg p-1" role="group" aria-label="Dashboard experience">
      {(["guided", "pro"] as const).map((option) => (
        <Button
          key={option}
          type="button"
          variant={mode === option ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={mode === option}
          onClick={() => setMode(option)}
          className="capitalize"
        >
          {option}
        </Button>
      ))}
    </div>
  )
}

export function ProDashboardSection({ children }: { children: React.ReactNode }) {
  const { mode } = useContext(DashboardExperienceContext)
  return mode === "pro" ? children : null
}
