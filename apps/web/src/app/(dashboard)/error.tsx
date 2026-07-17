"use client"

import { AlertTriangle } from "lucide-react"
import { Button, EmptyState } from "@lyrashield/ui"

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="This page could not load"
      description="Your data has not been changed. Try again, or return to Overview and choose another task."
      action={<Button onClick={reset}>Try again</Button>}
    />
  )
}
