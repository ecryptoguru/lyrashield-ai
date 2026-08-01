"use client"

import { useState } from "react"
import Link from "next/link"
import { Terminal, Copy, Check } from "lucide-react"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { writeClipboard } from "@/components/scorecard-share-composer"

const INSTALL_CMD = "npx lyrashield@latest install <agent>"
const LOGIN_CMD = "lyrashield login"
const DOCTOR_CMD = "lyrashield doctor"

export function CliIntegration({ docsUrl }: { docsUrl: string }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

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
            <Terminal className="size-4" aria-hidden="true" />
          </span>
          CLI
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-muted-foreground text-sm leading-6">
          Install the LyraShield CLI to scan from your terminal or wire it into your coding agent.
        </p>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Install</span>
          <div className="flex w-full min-w-0 items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2.5 font-mono text-xs whitespace-nowrap sm:text-sm">
              {INSTALL_CMD}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copy(INSTALL_CMD, "install")}
              aria-label="Copy install command"
              className="min-h-11 min-w-11 shrink-0 sm:min-h-9"
            >
              {copiedKey === "install" ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              <span className="sr-only sm:not-sr-only sm:ml-1">
                {copiedKey === "install" ? "Copied" : "Copy"}
              </span>
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Replace{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">&lt;agent&gt;</code>{" "}
            with your agent — e.g.{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">claude-code</code>,{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">cursor</code>,{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">vscode</code> — see{" "}
            <Link
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:no-underline"
            >
              supported agents
            </Link>{" "}
            for the full list.
          </p>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium">Setup</span>
          <ol className="text-muted-foreground ml-5 list-decimal space-y-3 text-sm">
            <li className="leading-6">
              Create an API key in{" "}
              <Link
                href="/dashboard/settings"
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                Settings → API keys
              </Link>{" "}
              — keys are shown once at creation.
            </li>
            <li className="space-y-2 leading-6">
              <div>
                Run{" "}
                <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-xs">
                  {LOGIN_CMD}
                </code>{" "}
                and paste your{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">lsk_</code> key. It
                is saved to{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                  ~/.lyrashield/credentials.json
                </code>
                .
              </div>
              <div className="flex w-full min-w-0 items-center gap-2">
                <code className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2.5 font-mono text-xs whitespace-nowrap sm:text-sm">
                  {LOGIN_CMD}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(LOGIN_CMD, "login")}
                  aria-label="Copy login command"
                  className="min-h-11 min-w-11 shrink-0 sm:min-h-9"
                >
                  {copiedKey === "login" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  <span className="sr-only sm:not-sr-only sm:ml-1">
                    {copiedKey === "login" ? "Copied" : "Copy"}
                  </span>
                </Button>
              </div>
            </li>
            <li className="space-y-2 leading-6">
              <div>
                Run{" "}
                <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-xs">
                  {DOCTOR_CMD}
                </code>{" "}
                to verify. Then try{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                  lyrashield scan
                </code>
                .
              </div>
              <div className="flex w-full min-w-0 items-center gap-2">
                <code className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2.5 font-mono text-xs whitespace-nowrap sm:text-sm">
                  {DOCTOR_CMD}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(DOCTOR_CMD, "doctor")}
                  aria-label="Copy doctor command"
                  className="min-h-11 min-w-11 shrink-0 sm:min-h-9"
                >
                  {copiedKey === "doctor" ? (
                    <Check className="size-4" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  <span className="sr-only sm:not-sr-only sm:ml-1">
                    {copiedKey === "doctor" ? "Copied" : "Copy"}
                  </span>
                </Button>
              </div>
            </li>
          </ol>
        </div>

        {copyError ? (
          <p role="alert" className="text-destructive text-xs">
            Copy failed. Select the command manually.
          </p>
        ) : null}

        <p className="text-muted-foreground bg-muted/40 rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed">
          For most agents the CLI writes the config file for you; for some (Cline, JetBrains,
          PiCode, OpenClaw, Hermes) print values to paste, Amp shells out to its vendor CLI.
        </p>

        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span>
            Also available as{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">@lyrashield/cli</code>.
          </span>
          <Link
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Docs: /docs/integrations
          </Link>
          <span className="hidden sm:inline">·</span>
          <Link
            href="/dashboard/settings"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Go to API keys
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
