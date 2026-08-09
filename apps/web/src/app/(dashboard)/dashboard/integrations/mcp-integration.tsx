"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, Copy, ExternalLink, Plug } from "lucide-react"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { writeClipboard } from "@/components/scorecard-share-composer"

export function McpIntegration({ endpointUrl, docsUrl }: { endpointUrl: string; docsUrl: string }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  const apiUrl = endpointUrl.replace(/\/api\/mcp$/, "")

  // Copy-paste-ready config for the two most common setups. Local stdio uses
  // credentials from `lyrashield login --oauth`; remote config remains the API-key fallback.
  const localConfig = `{
  "mcpServers": {
    "lyrashield": {
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"],
      "env": {
        "LYRASHIELD_API_URL": "${apiUrl}"
      }
    }
  }
}`
  const remoteConfig = `{
  "mcpServers": {
    "lyrashield": {
      "type": "http",
      "url": "${endpointUrl}",
      "headers": {
        "Authorization": "Bearer <paste lsk_ key>"
      }
    }
  }
}`

  async function copy(value: string, key: string) {
    setCopyError(null)
    try {
      await writeClipboard(value)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 2000)
    } catch {
      setCopyError(key)
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
          Connect coding agents like Claude Code, Cursor, and cloud IDEs to LyraShield so they can
          read evidence and scan results from this workspace.
        </p>

        <div className="border-primary/30 bg-primary/5 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Recommended: connect with OAuth</p>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                Marketplace clients use protected-resource discovery, select one workspace, and
                start read-only. Write actions always stay behind LyraShield approval.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="min-h-10 shrink-0"
              onClick={() => window.open(`${docsUrl}#oauth`, "_blank", "noopener,noreferrer")}
            >
              Connection guide <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Endpoint</span>
          <div className="flex w-full min-w-0 items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2.5 font-mono text-xs sm:text-sm">
              {endpointUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copy(endpointUrl, "endpoint")}
              aria-label="Copy MCP endpoint URL"
              className="min-h-11 min-w-11 shrink-0 sm:min-h-9"
            >
              {copiedKey === "endpoint" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only sm:not-sr-only sm:ml-1">
                {copiedKey === "endpoint" ? "Copied" : "Copy"}
              </span>
            </Button>
          </div>
          {copyError ? (
            <p role="alert" className="text-destructive text-xs">
              Copy failed. Select the text manually.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Local config (OAuth CLI login)</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(localConfig, "local")}
              aria-label="Copy local MCP config"
              className="min-h-11 shrink-0 sm:min-h-9"
            >
              {copiedKey === "local" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              <span className="ml-1">{copiedKey === "local" ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <pre
            className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-5"
            tabIndex={0}
            aria-label="MCP local configuration"
          >
            <code>{localConfig}</code>
          </pre>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              API-key fallback (cloud IDEs — Lovable, Bolt, Replit, v0)
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copy(remoteConfig, "remote")}
              aria-label="Copy remote MCP config"
              className="min-h-11 shrink-0 sm:min-h-9"
            >
              {copiedKey === "remote" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              <span className="ml-1">{copiedKey === "remote" ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <pre
            className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-5"
            tabIndex={0}
            aria-label="MCP remote configuration"
          >
            <code>{remoteConfig}</code>
          </pre>
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">API-key fallback</span>
          <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-sm">
            <li>
              Create an API key in{" "}
              <Link
                href="/dashboard/settings"
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                Settings → API keys
              </Link>{" "}
              (key starts with <code className="bg-muted rounded px-1 font-mono text-xs">lsk_</code>
              ).
            </li>
            <li>
              Add this endpoint to your agent as an MCP server authenticated with{" "}
              <code className="bg-muted rounded px-1 font-mono text-xs">Bearer &lt;key&gt;</code>.
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

        <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs leading-relaxed">
          OAuth connections are read-only by default. Any write scope is explicit and still requires
          the exact-argument LyraShield approval flow. Use API keys only for CI or clients without
          OAuth.
        </p>
      </CardContent>
    </Card>
  )
}
