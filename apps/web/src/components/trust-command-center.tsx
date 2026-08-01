"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { ShieldCheck, Clock, ListChecks } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, Badge, buttonVariants, cn } from "@lyrashield/ui"
import { RUN_SINGULAR } from "@/lib/terminology"
import { estimateRunMinutes, formatEstimate } from "@/lib/estimator"
import Link from "next/link"
import { modeLabel } from "@/lib/labels"

function trustPlanLabel(data: unknown): string {
  if (!data || typeof data !== "object") return "Default"
  const plan = data as Record<string, unknown>
  const preset =
    plan.preRelease && Array.isArray(plan.preRelease) && plan.preRelease.length > 0
      ? String(plan.preRelease[0])
      : null
  if (preset)
    return preset
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
  if (plan.recurring && Array.isArray(plan.recurring) && plan.recurring.length > 0) {
    const first = plan.recurring[0] as Record<string, unknown>
    if (typeof first.preset === "string")
      return String(first.preset)
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return "Configured"
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
      mql.addEventListener("change", callback)
      return () => mql.removeEventListener("change", callback)
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  )
}

// Matches the --ease-out token: cubic-bezier(0.2, 0, 0, 1).
function easeOutProgress(t: number): number {
  return 3 * t * t - 2 * t * t * t
}

function useCountUp(target: number, durationMs = 900): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(0)

  useEffect(() => {
    if (reduced) return

    let raf = 0
    const start = performance.now()

    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(1, elapsed / durationMs)
      setValue(Math.round(target * easeOutProgress(progress)))
      if (progress < 1) {
        raf = requestAnimationFrame(tick)
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs, reduced])

  return value
}

export function TrustCommandCenter({
  productName,
  mode,
  assetCount,
  riskScore,
  trustPlanData,
  completedScanCount = 0,
  latestScore = null,
}: {
  productName: string
  /** Depth of the most recent review, or null when none has run yet. */
  mode: string | null
  assetCount: number
  riskScore: number
  trustPlanData: unknown
  completedScanCount?: number
  latestScore?: { score: number; grade: string } | null
}) {
  const reduced = useReducedMotion()
  const [isRevealed, setIsRevealed] = useState(reduced)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  const estimate = estimateRunMinutes(mode ?? "SAFE", assetCount)

  const hasCompletedReview = completedScanCount > 0 && latestScore !== null
  const score = latestScore?.score ?? riskScore
  const countedScore = useCountUp(score)
  const animatedScore = reduced ? score : countedScore

  const verdictVariant = !hasCompletedReview
    ? "muted"
    : score >= 80
      ? "success"
      : score >= 50
        ? "warning"
        : "danger"
  const verdictText = !hasCompletedReview
    ? "Not evaluated"
    : score >= 80
      ? "Ready to ship within completed scope"
      : score >= 50
        ? "Needs attention"
        : "Needs action"

  const revealBase = "transition-[opacity,transform] duration-(--duration-slow) ease-(--ease-out)"
  const revealHidden = "opacity-0 translate-y-2"
  const revealVisible = "opacity-100 translate-y-0"

  const metrics = [
    {
      key: "time",
      title: "Estimated time",
      icon: Clock,
      content: (
        <>
          <div className="flex items-center gap-2">
            <Clock className="text-primary size-5" aria-hidden="true" />
            <span className="text-2xl font-bold">{formatEstimate(estimate)}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            For {assetCount} asset{assetCount === 1 ? "" : "s"}
            {mode ? ` in ${modeLabel(mode).toLowerCase()} mode` : ""}
          </p>
        </>
      ),
    },
    {
      key: "plan",
      title: "Trust plan",
      icon: ListChecks,
      content: (
        <>
          <div className="flex items-center gap-2">
            <ListChecks className="text-primary size-5" aria-hidden="true" />
            <span className="text-lg font-semibold">{trustPlanLabel(trustPlanData)}</span>
          </div>
          <Link
            href="/dashboard/settings"
            className="text-muted-foreground decoration-border hover:text-foreground text-xs underline underline-offset-4"
          >
            Review and customise controls.
          </Link>
        </>
      ),
    },
    {
      key: "verdict",
      title: "Latest verdict",
      icon: ShieldCheck,
      content: (
        <>
          <Badge variant={verdictVariant as "success" | "warning" | "danger" | "muted"}>
            {verdictText}
          </Badge>
          <p className="text-muted-foreground text-xs">
            {hasCompletedReview
              ? `Based on the latest completed review (${completedScanCount} total).`
              : "Run your first review to see evidence."}
          </p>
        </>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div
        className={cn(
          revealBase,
          isRevealed ? revealVisible : revealHidden,
          "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
        )}
      >
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{productName}</h2>
          <p className="text-muted-foreground text-sm">
            Product trust score and active review plan
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={verdictVariant as "success" | "warning" | "danger" | "muted"}>
            {animatedScore}/100
          </Badge>
          <Link
            href="/dashboard/scans?new=1"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            Start {RUN_SINGULAR}
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {metrics.map((metric, index) => (
          <Card
            key={metric.key}
            className={cn(revealBase, isRevealed ? revealVisible : revealHidden)}
            style={{ transitionDelay: `${(index + 1) * 75}ms` }}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{metric.title}</CardTitle>
            </CardHeader>
            <CardContent>{metric.content}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
