"use client"

import { useState } from "react"
import Link from "next/link"
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@lyrashield/ui"
import { Check, Copy, ExternalLink, Terminal, CircleDashed } from "lucide-react"
import { writeClipboard } from "@/components/scorecard-share-composer"

type StrategyLabel =
  | "Auto-installs a config file"
  | "Uses your agent's own installer"
  | "Shows values to paste"
  | "Installs a portable Agent Plugin"

export interface AgentCardData {
  id: string
  displayName: string
  docsSlug: string
  installStrategy: "config-file" | "vendor-cli" | "guided-manual" | "agent-plugin"
  locations: { scope: "project" | "global"; path: string; sharedByConvention: boolean }[]
  pluginLocations?: { scope: "project" | "global"; path: string; sharedByConvention: boolean }[]
  rulesFiles: string[]
}

function strategyLabel(s: AgentCardData["installStrategy"]): StrategyLabel {
  if (s === "config-file") return "Auto-installs a config file"
  if (s === "vendor-cli") return "Uses your agent's own installer"
  if (s === "agent-plugin") return "Installs a portable Agent Plugin"
  return "Shows values to paste"
}

function StrategyBadge({ strategy }: { strategy: AgentCardData["installStrategy"] }) {
  const label = strategyLabel(strategy)
  const variant =
    strategy === "config-file"
      ? ("success" as const)
      : strategy === "vendor-cli"
        ? ("info" as const)
        : strategy === "agent-plugin"
          ? ("info" as const)
          : ("muted" as const)
  return (
    <Badge variant={variant} className="shrink-0 text-[11px]">
      {label}
    </Badge>
  )
}

function AgentCard({ agent, docsBaseUrl }: { agent: AgentCardData; docsBaseUrl: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const installCmd = `npx lyrashield install ${agent.id}`
  const locations = agent.pluginLocations?.length ? agent.pluginLocations : agent.locations
  const primaryLocation = locations[0]?.path ?? null

  async function handleCopy() {
    setCopyError(null)
    try {
      await writeClipboard(installCmd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError("Copy failed — select the command manually.")
    }
  }

  return (
    <Card className="flex min-h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle as="h2" className="min-w-0 flex-1 text-base leading-tight tracking-tight">
            {agent.displayName}
          </CardTitle>
          <StrategyBadge strategy={agent.installStrategy} />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <CircleDashed className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-muted-foreground text-[11px] leading-5 font-medium">
            Verify local setup with lyrashield doctor
          </span>
        </div>
        {primaryLocation ? (
          <p className="text-muted-foreground mt-2 line-clamp-2 font-mono text-[11px] leading-5 break-all">
            {locations.map((l) => l.path).join(" · ")}
          </p>
        ) : (
          <p className="text-muted-foreground mt-2 text-[11px] leading-5">
            Managed inside the agent UI
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 pt-0">
        {agent.rulesFiles.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Rules / skills
            </p>
            <div className="flex flex-wrap gap-1.5">
              {agent.rulesFiles.map((file) => (
                <code
                  key={file}
                  className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[11px] leading-5"
                >
                  {file}
                </code>
              ))}
            </div>
            <p className="text-muted-foreground text-[11px] leading-4">
              Keep in sync with{" "}
              <code className="bg-muted rounded px-1 py-0 font-mono text-[11px]">
                lyrashield rules add
              </code>
            </p>
          </div>
        ) : (
          <div className="min-h-8" />
        )}

        <div className="mt-auto flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2.5 py-2 font-mono text-[11px]">
              {installCmd}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCopy()}
              aria-label={`Copy install command for ${agent.displayName}`}
              className="min-h-11 min-w-11 shrink-0"
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

          <div className="grid grid-cols-2 gap-2">
            <Link
              href={`/dashboard/agents/${agent.id}`}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold whitespace-nowrap transition-colors sm:min-h-9"
            >
              Set up
            </Link>
            <a
              href={`${docsBaseUrl}/${agent.docsSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-card hover:bg-accent inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium whitespace-nowrap transition-colors sm:min-h-9"
            >
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
              Docs
            </a>
            <div
              className="bg-muted/60 text-muted-foreground col-span-2 inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-md border px-2 font-mono text-[11px] sm:min-h-9"
              title={installCmd}
            >
              <Terminal className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{agent.id}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function AgentsGrid({
  agents,
  docsBaseUrl,
}: {
  agents: AgentCardData[]
  docsBaseUrl: string
}) {
  if (agents.length === 0) {
    return <p className="text-muted-foreground text-sm">No agents registered.</p>
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} docsBaseUrl={docsBaseUrl} />
      ))}
    </div>
  )
}
