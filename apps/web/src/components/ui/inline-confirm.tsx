"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@lyrashield/ui"

/**
 * Renders a trigger button and, alongside it, the confirmation row it reveals —
 * a destructive confirm button and a cancel button, no native dialog.
 *
 * Both halves are rendered and the inactive half is hidden, rather than the
 * confirm row being created on the first click. A control that only exists
 * after a click is absent from the server-rendered markup, so the page ships
 * with no evidence of the action, and it cannot be reached at all before
 * hydration. Hiding the inactive half keeps the two-step interaction and the
 * focus handoff exactly as they were.
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const wasConfirmingRef = useRef(false)

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus()
      wasConfirmingRef.current = true
    } else if (wasConfirmingRef.current) {
      triggerRef.current?.focus()
      wasConfirmingRef.current = false
    }
  }, [confirming])

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        disabled={disabled}
        hidden={confirming}
        aria-label={ariaLabel}
        onClick={() => setConfirming(true)}
      >
        {triggerIcon}
        {triggerLabel}
      </Button>

      <span
        hidden={!confirming}
        className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
        role="group"
        aria-label={message}
      >
        {/* Wrap the full context and controls rather than clipping confirmation. */}
        <span className="text-muted-foreground min-w-0 wrap-break-word text-xs">{message}</span>
        <Button
          ref={confirmRef}
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
    </>
  )
}
