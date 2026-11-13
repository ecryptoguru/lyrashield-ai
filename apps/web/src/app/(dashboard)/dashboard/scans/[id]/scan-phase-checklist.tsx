"use client"

import { CheckCircle2, Circle, Loader2 } from "lucide-react"
import { Badge } from "@lyrashield/ui"
import type { ScanPhase } from "./scan-detail-utils"

/**
 * The ordered phase checklist for a running scan. It was the right-hand column
 * of ScanInProgress and moved here unchanged so that component stays inside the
 * size ratchet. The same phases, the same states, the same markup.
 */
export function ScanPhaseChecklist({ phases }: { phases: ScanPhase[] }) {
  if (phases.length === 0) return null

  return (
    <ol className="flex shrink-0 flex-col gap-2.5 sm:items-end" aria-label="Scan phases">
      {phases.map((phase) => (
        <li key={phase.key} className="flex items-center gap-2 text-sm">
          {phase.state === "done" && (
            <>
              <CheckCircle2
                className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
                aria-hidden="true"
              />
              <span className="text-teal-600 dark:text-teal-400">{phase.label}</span>
              <Badge variant="success" className="text-xs">
                Done
              </Badge>
            </>
          )}
          {phase.state === "active" && (
            <>
              <Loader2
                className="h-4 w-4 shrink-0 animate-spin text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <span className="font-medium text-amber-600 dark:text-amber-400">{phase.label}</span>
              <Badge variant="warning" className="text-xs">
                Active
              </Badge>
            </>
          )}
          {phase.state === "pending" && (
            <>
              <Circle className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-muted-foreground">{phase.label}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
