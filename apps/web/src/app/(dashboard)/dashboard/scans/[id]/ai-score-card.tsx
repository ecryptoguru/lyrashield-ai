"use client"

import { Card } from "@lyrashield/ui"
import { Brain } from "lucide-react"

export interface AiSecurityScoreData {
  score: number | null
  methodology: string
  assessedCount: number
  totalControls: number
  evidenceQuality: Record<string, number> | null
  reason: string | null
  ai03: unknown
  triage: unknown
  computedAt: string
}

function triageSummary(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const status = typeof record.status === "string" ? record.status : null
  const reason = typeof record.terminalReason === "string" ? record.terminalReason : null
  if (!status) return null
  if (status === "COMPLETED") return "AI-assisted triage added bounded review metadata."
  return `AI-assisted triage unavailable: ${reason ?? status}.`
}

function ai03Summary(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.fresh !== true) return "AI-03 advisory coverage is not fresh."
  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : null
  return fetchedAt
    ? `AI-03 advisory data current as of ${fetchedAt}.`
    : "AI-03 advisory data is fresh."
}

export function AiSecurityScoreCard({ data }: { data: AiSecurityScoreData | null }) {
  const triage = data ? triageSummary(data.triage) : null
  const ai03 = data ? ai03Summary(data.ai03) : null
  if (!data || data.score === null) {
    return (
      <Card className="border-0 p-4 shadow-none" aria-live="polite">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Brain className="h-4 w-4" aria-hidden="true" />
          AI App Security
        </div>
        <p className="text-muted-foreground mt-1 text-sm">Not scored</p>
        {data && (
          <>
            <p className="text-muted-foreground text-xs">
              Assessed {data.assessedCount} of {data.totalControls}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {data.reason ?? "No eligible score snapshot."}
            </p>
            {ai03 && <p className="text-muted-foreground mt-1 text-xs">{ai03}</p>}
            {triage && <p className="text-muted-foreground mt-1 text-xs">{triage}</p>}
          </>
        )}
      </Card>
    )
  }

  const color =
    data.score >= 90
      ? "text-emerald-600 dark:text-emerald-400"
      : data.score >= 70
        ? "text-sky-600 dark:text-sky-400"
        : data.score >= 50
          ? "text-amber-600 dark:text-amber-400"
          : "text-destructive"

  return (
    <Card className="border-0 p-4 shadow-none" aria-live="polite">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Brain className="h-4 w-4" aria-hidden="true" />
        AI App Security
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${color}`}>{data.score}</span>
        <span className="text-muted-foreground text-sm">/ 100</span>
      </div>
      <p className="text-muted-foreground text-xs">
        Assessed {data.assessedCount} of {data.totalControls} · {data.methodology}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Private score — not a certification or guarantee.
      </p>
      {ai03 && <p className="text-muted-foreground mt-1 text-xs">{ai03}</p>}
      {triage && <p className="text-muted-foreground mt-1 text-xs">{triage}</p>}
    </Card>
  )
}
