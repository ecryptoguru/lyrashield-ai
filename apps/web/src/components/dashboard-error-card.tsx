"use client"

import { AlertCircle } from "lucide-react"
import { Button, Card } from "@lyrashield/ui"

/**
 * The one dashboard error strip: icon, message, and an optional retry action.
 *
 * List clients (findings, notifications, reports, schedules) and full-page
 * fetch failures (projects, targets, team) previously each hand-rolled this
 * markup, so icon presence, role="alert", and the retry affordance drifted.
 * Consolidated here; page-specific layouts (a drawer's inline error, a form
 * field's error line, a recovery flow with extra actions) keep their own
 * rendering when this shape does not fit.
 */
export function DashboardErrorCard({
  message,
  onRetry,
  retryLabel = "Retry",
  className = "mb-4 p-4",
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
  className?: string
}) {
  return (
    <Card className={`border-destructive/50 ${className}`}>
      <div className="text-destructive flex items-center gap-2 text-sm" role="alert">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{message}</span>
        {onRetry && (
          <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </div>
    </Card>
  )
}
