"use client"

import { useState } from "react"
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { writeClipboard } from "./scorecard-share-composer"

interface ApiErrorCardProps {
  error: Error & { digest?: string }
  reset?: () => void
}

const MAX_ERROR_MESSAGE_LENGTH = 500

export function safeApiErrorMessage(message: unknown): string {
  if (typeof message !== "string") return "Unknown error"
  const sanitized = message.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()
  if (!sanitized) return "Unknown error"
  return sanitized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : sanitized
}

export function ApiErrorCard({ error, reset }: ApiErrorCardProps) {
  const [copied, setCopied] = useState(false)
  const message = safeApiErrorMessage(error.message)

  const details = [
    `Message: ${message}`,
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
          <CardTitle className="text-destructive text-lg">This page could not load</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-foreground text-sm wrap-break-word">{message}</p>
        {error.digest ? (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Error digest
            </p>
            <code className="bg-background border-input block max-h-24 overflow-auto rounded border p-2 font-mono text-xs break-all">
              {error.digest}
            </code>
            <p className="text-muted-foreground text-xs">
              Share this digest with support to help trace the failure.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {reset ? (
            <Button type="button" onClick={reset}>
              <RotateCcw className="mr-2 size-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void copyDetails()}>
            {copied ? (
              <Check className="mr-2 size-4" aria-hidden="true" />
            ) : (
              <Copy className="mr-2 size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy details"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
