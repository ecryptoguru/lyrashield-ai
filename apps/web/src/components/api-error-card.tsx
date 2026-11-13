"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react"
import { Button, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@lyrashield/ui"
import { writeClipboard } from "./scorecard-share-composer"
import { safeApiErrorMessage } from "@/lib/safe-api-error-message"
export { safeApiErrorMessage } from "@/lib/safe-api-error-message"

/**
 * What a user reads when a page failed to render. It is fixed copy, never the
 * error's own text: a boundary catches framework sentences, stack frames,
 * internal paths and provider bodies, and none of them are something a user can
 * act on. The raw message and the digest stay available behind the explicit
 * copy action so support can still trace the failure.
 */
export const PAGE_LOAD_FAILURE_MESSAGE =
  "Something went wrong while loading this page. Try again, and if it keeps failing contact support."

interface ApiErrorCardProps {
  error: Error & { digest?: string }
  reset?: () => void
  /** Route-specific recovery, when one exists. */
  recovery?: { href: string; label: string }
}

export function ApiErrorCard({ error, reset, recovery }: ApiErrorCardProps) {
  const [copied, setCopied] = useState(false)

  // Support details are only ever put on the clipboard by an explicit click,
  // never painted into the page.
  const details = [
    `Message: ${safeApiErrorMessage(error.message)}`,
    ...(error.digest ? [`Digest: ${error.digest}`] : []),
  ].join("\n")

  async function copyDetails() {
    try {
      await writeClipboard(details)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // The button already communicates failure by not flashing the copied icon.
    }
  }

  return (
    <Card
      role="alert"
      aria-live="assertive"
      className="border-destructive/50 bg-destructive/5 mx-auto mt-8 max-w-2xl"
    >
      <CardHeader className="flex flex-row items-start gap-3 pb-2">
        <AlertTriangle className="text-destructive mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <CardTitle className="text-destructive text-lg">We could not load this page</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-foreground text-sm wrap-break-word">{PAGE_LOAD_FAILURE_MESSAGE}</p>

        <div className="flex flex-wrap items-center gap-2">
          {reset ? (
            <Button type="button" onClick={reset}>
              <RotateCcw className="mr-2 size-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          {recovery ? (
            <Link href={recovery.href} className={buttonVariants({ variant: "outline" })}>
              {recovery.label}
            </Link>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void copyDetails()}>
            {copied ? (
              <Check className="mr-2 size-4" aria-hidden="true" />
            ) : (
              <Copy className="mr-2 size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy details for support"}
          </Button>
        </div>
        {error.digest ? (
          <p className="text-muted-foreground text-xs">
            The copied details include an error digest that support can use to trace this failure.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
