"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, Copy, Plug } from "lucide-react"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { writeClipboard } from "@/components/scorecard-share-composer"

export function McpIntegration({
  endpointUrl,
  docsUrl,
}: {
  endpointUrl: string
  docsUrl: string
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  async function handleCopy() {
    setCopyError(null)
    try {
      await writeClipboard(endpointUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError("Copy failed. Select the URL manually.")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-lg">
            <Plug className="size-4" aria-hidden="true" />
          </span>
          MCP server
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Connect coding agents like Claude Code, Cursor, and cloud IDEs to LyraShield so they can read
          evidence and scan results from this workspace.
        </p>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Endpoint</span>
          <div className="flex w-full min-w-0 items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2.5 font-mono text-xs sm:text-sm">
              {endpointUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCopy()}
              aria-label="Copy MCP endpoint URL"
              className="min-h-11 min-w-11 shrink-0 sm:min-h-9"
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only sm:not-sr-only sm:ml-1">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          {copyError ? (
            <p role="alert" className="text-destructive text-xs">
              {copyError}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Setup</span>
          <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-sm">
            <li>
              Create an API key in{" "}
              <Link
                href="/dashboard/settings"
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                Settings → API keys
              </Link>{" "}
              (key starts with <code className="rounded bg-muted px-1 font-mono text-xs">lsk_</code>).
            </li>
            <li>
              Add this endpoint to your agent as an MCP server authenticated with{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">Bearer &lt;key&gt;</code>.
            </li>
          </ol>
          <p className="text-sm">
            <Link
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              Docs: /docs/integrations
            </Link>
            {" · "}
            <Link
              href="/dashboard/settings"
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              Go to API keys
            </Link>
          </p>
        </div>

        <p className="text-muted-foreground rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed">
          Remote use is read-only by default. Your agent can fetch evidence and scan results; changes that
          write data happen on the local stdio MCP server where you approve them. A trusted automation can opt
          in to remote writes with{" "}
          <code className="rounded bg-muted px-1 font-mono">LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true</code>.
        </p>
      </CardContent>
    </Card>
  )
}
