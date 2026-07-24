"use client"

import { useState } from "react"
import { Button } from "@lyrashield/ui"

/**
 * Renders a trigger button. On first click it reveals an inline confirmation
 * row with a destructive confirm button and a cancel button — no native dialog.
 */
export function InlineConfirm({
  triggerLabel,
  triggerIcon,
  confirmLabel = "Confirm",
  message,
  onConfirm,
  disabled = false,
  triggerVariant = "ghost",
  triggerSize = "sm",
  "aria-label": ariaLabel,
}: {
  triggerLabel?: React.ReactNode
  triggerIcon?: React.ReactNode
  confirmLabel?: string
  message: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  triggerVariant?: "ghost" | "outline" | "secondary" | "default" | "destructive"
  triggerSize?: "sm" | "md" | "lg" | "icon"
  "aria-label"?: string
}) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setConfirming(true)}
      >
        {triggerIcon}
        {triggerLabel}
      </Button>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5" role="group" aria-label={message}>
      <span className="text-muted-foreground hidden text-xs sm:inline">{message}</span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={async () => {
          setConfirming(false)
          await onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  )
}
