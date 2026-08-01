"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { CheckCircle2, Circle, X } from "lucide-react"

/**
 * First-run get-started checklist (Batch F4). Shown only for workspaces with
 * zero completed scans — the moment a brand-new user most needs "what do I do
 * next?". Dismissal persists per workspace in localStorage. Auto-hides once
 * every step is complete (the metric grid then carries the story). Elevates
 * the existing assuranceSteps concept into a visual, engaging guide.
 */

export interface ChecklistStep {
  label: string
  complete: boolean
  href: string
}

export function GetStartedChecklist({
  workspaceId,
  steps,
}: {
  workspaceId: string
  steps: ChecklistStep[]
}) {
  const storageKey = `lyrashield-get-started-dismissed:${workspaceId}`
  const [dismissed, setDismissed] = useState(true) // hidden until we know
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Defer to a microtask so setState is inside a callback, not the
    // synchronous effect body (avoids react-hooks/set-state-in-effect).
    // Reads localStorage once, then marks mounted to reveal the checklist.
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

  const allComplete = steps.every((step) => step.complete)
  if (allComplete) return null

  const doneCount = steps.filter((step) => step.complete).length

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey, "1")
    } catch {
      /* localStorage unavailable — just hide for this session */
    }
    setDismissed(true)
  }

  return (
    <section className="rounded-xl border p-5 sm:p-6" aria-labelledby="get-started-heading">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
            Get started
          </p>
          <h2 id="get-started-heading" className="mt-1 text-xl font-bold tracking-tight">
            Your first evidence record in {steps.length} steps
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {doneCount} of {steps.length} done — this takes a few minutes.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss get started checklist"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* Progress bar */}
      <div
        className="bg-muted mb-5 h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={doneCount}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-label="Get started progress"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-(--duration-slow) ease-out"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((step, index) => {
          const Icon = step.complete ? CheckCircle2 : Circle
          return (
            <li key={step.label}>
              <Link
                href={step.href}
                className={`flex min-h-16 items-center gap-3 rounded-lg border p-3.5 transition-colors ${
                  step.complete
                    ? "border-success/40 bg-success/5"
                    : "hover:bg-accent hover:border-primary/40"
                }`}
              >
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${
                    step.complete ? "bg-success/15 text-success" : "bg-primary/8 text-primary"
                  }`}
                  aria-hidden="true"
                >
                  {step.complete ? <Icon className="size-4" /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm font-medium ${
                      step.complete ? "text-muted-foreground line-through" : ""
                    }`}
                  >
                    {step.label}
                  </span>
                </span>
                {!step.complete && (
                  <span className="text-primary text-xs font-medium">Start →</span>
                )}
              </Link>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
