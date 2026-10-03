"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { ChevronRight, Play } from "lucide-react"
import { Button, Spinner } from "@lyrashield/ui"
import { SCAN_SINGULAR } from "@/lib/terminology"
import { isBillingRecoveryCode } from "./scans-client.utils"

export function useScanSheetErrorVisibility(open: boolean, errorMessage: string | null) {
  const wasOpenRef = useRef(open)
  const lastClosedErrorRef = useRef<string | null>(null)
  const previousErrorMessageRef = useRef(errorMessage)
  const [suppressedErrorMessage, setSuppressedErrorMessage] = useState<string | null>(null)
  const submissionErrorRef = useRef<HTMLDivElement | null>(null)
  const visibleErrorMessage =
    errorMessage && errorMessage !== suppressedErrorMessage ? errorMessage : null
  const lastAnnouncedErrorRef = useRef(visibleErrorMessage)

  useEffect(() => {
    const wasOpenBefore = wasOpenRef.current
    const previousErrorMessage = previousErrorMessageRef.current

    if (!open && wasOpenBefore) {
      lastClosedErrorRef.current = errorMessage
      setSuppressedErrorMessage(null)
    } else if (open && !wasOpenBefore) {
      setSuppressedErrorMessage(lastClosedErrorRef.current === errorMessage ? errorMessage : null)
    } else if (open && previousErrorMessage !== errorMessage) {
      setSuppressedErrorMessage(null)
    }

    wasOpenRef.current = open
    previousErrorMessageRef.current = errorMessage
  }, [open, errorMessage])

  useEffect(() => {
    if (open && visibleErrorMessage && visibleErrorMessage !== lastAnnouncedErrorRef.current) {
      submissionErrorRef.current?.focus({ preventScroll: true })
    }
    lastAnnouncedErrorRef.current = visibleErrorMessage
  }, [open, visibleErrorMessage])

  return { submissionErrorRef, visibleErrorMessage }
}

export function ScanSubmissionFooter({
  errorCode,
  errorMessage,
  recoveryError,
  canManageBilling,
  creating,
  startDisabled,
  onStart,
  onCancel,
  submissionErrorRef,
}: {
  errorCode: string | null
  errorMessage: string | null
  recoveryError: string | null
  canManageBilling: boolean
  creating: boolean
  startDisabled: boolean
  onStart: () => Promise<void>
  onCancel: () => void
  submissionErrorRef: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div role="group" aria-label="Scan submission" className="border-t px-6 py-4">
      {(errorMessage || recoveryError) && (
        <div
          ref={submissionErrorRef}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          tabIndex={-1}
          className="border-destructive/40 mb-3 rounded-lg border p-3 text-sm"
        >
          {errorMessage && <p>{errorMessage}</p>}
          {recoveryError && recoveryError !== errorMessage && <p>{recoveryError}</p>}
          {errorMessage &&
            isBillingRecoveryCode(errorCode) &&
            (canManageBilling ? (
              <Link
                href="/dashboard/billing"
                className="text-primary mt-2 inline-flex min-h-11 items-center gap-1 font-medium hover:underline"
              >
                Review billing options
                <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <p className="text-muted-foreground mt-2">
                Ask a workspace owner to review billing options.
              </p>
            ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={onStart} disabled={startDisabled} className="min-h-11 flex-1">
          {creating ? (
            <>
              <Spinner className="mr-2 h-4 w-4" />
              Starting…
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
              Start {SCAN_SINGULAR}
            </>
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} className="min-h-11">
          Cancel
        </Button>
      </div>
    </div>
  )
}
