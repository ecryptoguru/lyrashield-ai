"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Bug, ChevronLeft, ChevronRight, GitPullRequest, Play, Plug, Target, X } from "lucide-react"
import { Button } from "@lyrashield/ui"

/**
 * One-time five-step feature tour for new users. Replaces the removed
 * Guided/Pro dashboard experience split: the dashboard now has a single mode
 * with everything visible, and this tour carries the "what is what"
 * explanation instead of hiding sections behind a toggle.
 *
 * Dismissal persists per workspace in localStorage (same pattern as
 * GetStartedChecklist). The tour explains features; the checklist below it
 * drives first actions — they are deliberately complementary, not redundant.
 */

export interface FeatureTourStep {
  title: string
  description: string
  href: string
  cta: string
}

/** Exported for tests: the tour is exactly five steps, matching real nav surfaces. */
export const FEATURE_TOUR_STEPS: FeatureTourStep[] = [
  {
    title: "Add a Target",
    description:
      "Point LyraShield at your app, API or repository. Targets are what your plan protects and where every Trust Run starts.",
    href: "/dashboard/targets",
    cta: "Open Targets",
  },
  {
    title: "Start a Trust Run",
    description:
      "An AI security agent pentests your target and checks dependencies and secrets — metered in agent minutes, capped by your budget.",
    href: "/dashboard/scans",
    cta: "Open Trust Runs",
  },
  {
    title: "Review verified Issues",
    description:
      "Every issue ships with evidence captured during the run — proof, not noise. Triage by severity and dig into the details.",
    href: "/dashboard/findings",
    cta: "Open Issues",
  },
  {
    title: "Approve fixes in the Review Queue",
    description:
      "LyraShield proposes fix PRs. Nothing changes your code without your approval, and a retest confirms each fix landed.",
    href: "/dashboard/approvals",
    cta: "Open Review Queue",
  },
  {
    title: "Connect Coding Agents & CI",
    description:
      "Wire up Claude Code, Cursor and more via MCP, gate pull requests with the GitHub Action and share your scorecard.",
    href: "/dashboard/agents",
    cta: "Open Coding Agents",
  },
]

export function featureTourStorageKey(workspaceId: string): string {
  return `lyrashield-feature-tour-dismissed:${workspaceId}`
}

const ICONS = [Target, Play, Bug, GitPullRequest, Plug] as const

export function FeatureTour({ workspaceId }: { workspaceId: string }) {
  const storageKey = featureTourStorageKey(workspaceId)
  const [dismissed, setDismissed] = useState(true) // hidden until we know
  const [mounted, setMounted] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    // Defer to a microtask so setState is inside a callback, not the
    // synchronous effect body (avoids react-hooks/set-state-in-effect).
    let cancelled = false
    const schedule = () => {
      if (cancelled) return
      try {
        setDismissed(window.localStorage.getItem(storageKey) === "1")
      } catch {
        setDismissed(false)
      }
      setMounted(true)
    }
    if (typeof queueMicrotask === "function") queueMicrotask(schedule)
    else setTimeout(schedule, 0)
    return () => {
      cancelled = true
    }
  }, [storageKey])

  if (!mounted || dismissed) return null

  const total = FEATURE_TOUR_STEPS.length
  const current = FEATURE_TOUR_STEPS[step]!
  const Icon = ICONS[step] ?? Target
  const isLast = step === total - 1

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey, "1")
    } catch {
      /* localStorage unavailable — just hide for this session */
    }
    setDismissed(true)
  }

  return (
    <section
      className="border-primary/30 bg-primary/[0.03] rounded-xl border p-5 sm:p-6"
      aria-labelledby="feature-tour-heading"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
            Welcome to LyraShield
          </p>
          <p className="text-muted-foreground mt-1 text-xs" aria-live="polite">
            Step {step + 1} of {total}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Skip feature tour"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span
          className="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl"
          aria-hidden="true"
        >
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="feature-tour-heading" className="text-xl font-bold tracking-tight">
            {current.title}
          </h2>
          <p className="text-muted-foreground mt-1.5 max-w-2xl text-sm">{current.description}</p>
          <Link
            href={current.href}
            className="text-primary mt-2 inline-block text-sm font-medium hover:underline"
          >
            {current.cta} →
          </Link>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5" role="group" aria-label="Tour steps">
          {FEATURE_TOUR_STEPS.map((tourStep, index) => (
            <button
              key={tourStep.title}
              type="button"
              onClick={() => setStep(index)}
              aria-label={`Step ${index + 1}: ${tourStep.title}`}
              aria-current={index === step ? "step" : undefined}
              className={`size-2.5 rounded-full transition-colors ${
                index === step
                  ? "bg-primary"
                  : "bg-muted-foreground/30 hover:bg-muted-foreground/60"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            disabled={step === 0}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Back
          </Button>
          {isLast ? (
            <Button type="button" size="sm" onClick={dismiss}>
              Finish tour
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setStep((value) => Math.min(total - 1, value + 1))}
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
