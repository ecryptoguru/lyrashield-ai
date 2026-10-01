"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select } from "@lyrashield/ui"
import { Check, Copy, ExternalLink, CircleDashed } from "lucide-react"
import { writeClipboard } from "@/components/scorecard-share-composer"

type InstallStrategy = "config-file" | "vendor-cli" | "guided-manual" | "agent-plugin"
type Scope = "project" | "global"

type AgentLocation = { scope: Scope; path: string; sharedByConvention: boolean }

export interface AgentCardData {
  id: string
  aliases?: string[]
  displayName: string
  productFamily?: { id: string; name: string }
  docsSlug: string
  surface?: "ide" | "cli" | "cloud" | "desktop" | "web"
  installStrategy: InstallStrategy
  locations: AgentLocation[]
  pluginLocations?: AgentLocation[]
  skillLocations?: AgentLocation[]
  nativeCapabilities?: string[]
  rulesFiles: string[]
  manualInstructions?: string
  installCommand: string | null
}

type AgentFamily = { id: string; name: string; agents: AgentCardData[] }

type StrategyLabel =
  | "MCP config setup"
  | "Uses your agent's own installer"
  | "Shows values to paste"
  | "Installs a portable Agent Plugin"

function strategyLabel(strategy: InstallStrategy): StrategyLabel {
  if (strategy === "config-file") return "MCP config setup"
  if (strategy === "vendor-cli") return "Uses your agent's own installer"
  if (strategy === "agent-plugin") return "Installs a portable Agent Plugin"
  return "Shows values to paste"
}

function StrategyBadge({ strategy }: { strategy: InstallStrategy }) {
  const variant =
    strategy === "config-file"
      ? ("success" as const)
      : strategy === "vendor-cli" || strategy === "agent-plugin"
        ? ("info" as const)
        : ("muted" as const)
  return (
    <Badge variant={variant} className="shrink-0 text-xs">
      {strategyLabel(strategy)}
    </Badge>
  )
}

function familyFor(agent: AgentCardData) {
  return agent.productFamily ?? { id: agent.id, name: agent.displayName }
}

function groupFamilies(agents: AgentCardData[]): AgentFamily[] {
  const groups = new Map<string, AgentFamily>()
  for (const agent of agents) {
    const family = familyFor(agent)
    const group = groups.get(family.id) ?? { ...family, agents: [] }
    group.agents.push(agent)
    groups.set(family.id, group)
  }
  return [...groups.values()]
}

function surfaceMatches(agent: AgentCardData, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [agent.id, agent.displayName, ...(agent.aliases ?? [])].some((value) =>
    value.toLocaleLowerCase().includes(normalized)
  )
}

function locationText(locations: AgentLocation[]) {
  return locations.map((location) => `${location.scope}: ${location.path}`)
}

function AgentCard({
  family,
  visibleAgents,
  selectedId,
  onSelect,
  docsBaseUrl,
  publishedCliVersion,
}: {
  family: AgentFamily
  visibleAgents: AgentCardData[]
  selectedId: string
  onSelect: (agentId: string) => void
  docsBaseUrl: string
  publishedCliVersion: string
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyGeneration = useRef(0)
  const selected = visibleAgents.find((agent) => agent.id === selectedId) ?? visibleAgents[0]!
  const pluginLocations = selected.pluginLocations?.length ? selected.pluginLocations : []
  const configLocations = pluginLocations.length ? pluginLocations : selected.locations
  const pluginProvidesSkills = selected.installStrategy === "agent-plugin"
  const ruleFiles = pluginProvidesSkills ? [] : selected.rulesFiles

  useEffect(
    () => () => {
      copyGeneration.current += 1
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    []
  )

  async function handleCopy() {
    if (!selected.installCommand) return
    const generation = ++copyGeneration.current
    setCopyError(null)
    setCopied(false)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    try {
      await writeClipboard(selected.installCommand)
      if (copyGeneration.current !== generation) return
      setCopied(true)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      if (copyGeneration.current !== generation) return
      setCopyError("Copy failed — select the command manually.")
    }
  }

  function handleSelect(agentId: string) {
    copyGeneration.current += 1
    setCopied(false)
    setCopyError(null)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    onSelect(agentId)
  }

  const familyTitleId = `agent-family-${family.id}`

  return (
    <Card role="group" aria-labelledby={familyTitleId} className="flex min-w-0 flex-col">
      <CardHeader className="pb-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle
            id={familyTitleId}
            as="h2"
            className="min-w-0 flex-1 text-base leading-tight tracking-tight"
          >
            {family.name}
          </CardTitle>
          <StrategyBadge strategy={selected.installStrategy} />
        </div>
        {visibleAgents.length > 1 ? (
          <label className="mt-3 block space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Client surface</span>
            <Select
              aria-label={`Choose ${family.name} client surface`}
              value={selected.id}
              onChange={(event) => handleSelect(event.target.value)}
              className="h-10 w-full"
            >
              {visibleAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <p className="text-muted-foreground mt-3 text-xs leading-5">
            Surface: {selected.displayName}
          </p>
        )}
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <CircleDashed className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-muted-foreground min-w-0 text-xs leading-5 font-medium">
            {selected.surface === "cloud" || selected.surface === "web"
              ? "After activation, confirm the hosted connection and available LyraShield tools."
              : "Verify after activation with LyraShield doctor."}
          </span>
        </div>
        {configLocations.length > 0 ? (
          <div className="text-muted-foreground mt-2 space-y-0.5 font-mono text-xs leading-5 break-all">
            {locationText(configLocations).map((location) => (
              <p key={location}>{location}</p>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground mt-2 text-xs leading-5">
            Managed inside the agent UI
          </p>
        )}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col gap-4 pt-0">
        <div className="space-y-3">
          {pluginProvidesSkills ? (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Skills
              </p>
              <p className="text-muted-foreground text-xs leading-5">
                Workflow skills ship with the Agent Plugin; no separate skills install is needed.
              </p>
            </div>
          ) : selected.skillLocations?.length ? (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Skills
              </p>
              {locationText(selected.skillLocations).map((location) => (
                <p
                  key={location}
                  className="text-muted-foreground font-mono text-xs leading-5 break-all"
                >
                  {location}
                </p>
              ))}
            </div>
          ) : null}

          {ruleFiles.length > 0 ? (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Rules
              </p>
              {ruleFiles.map((file) => (
                <p
                  key={file}
                  className="text-muted-foreground font-mono text-xs leading-5 break-all"
                >
                  {file}
                </p>
              ))}
            </div>
          ) : null}
        </div>

        {selected.installCommand ? (
          <div className="mt-auto space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <code
                className="bg-muted min-w-0 flex-1 truncate rounded-md px-2.5 py-2 font-mono text-xs"
                aria-label="Published install command"
                title={selected.installCommand}
              >
                {selected.installCommand}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleCopy()}
                aria-label={
                  copied
                    ? `Install command for ${selected.displayName}: copied`
                    : `Copy install command for ${selected.displayName}`
                }
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
            <p role="status" aria-live="polite" className="sr-only">
              {copied ? "Copied to clipboard." : ""}
            </p>
            {copyError ? (
              <p role="alert" className="text-destructive text-xs">
                {copyError}
              </p>
            ) : null}
          </div>
        ) : (
          <p role="status" className="text-muted-foreground mt-auto text-xs leading-5">
            No installer for this surface in the published LyraShield CLI {publishedCliVersion}. Use
            its setup guide below.
          </p>
        )}

        {selected.manualInstructions ? (
          <details className="bg-muted/40 rounded-md border px-3 py-2 text-xs leading-5">
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
              Manual setup notes
            </summary>
            <p className="text-muted-foreground mt-2 break-words">{selected.manualInstructions}</p>
          </details>
        ) : null}

        <div className="mt-auto grid grid-cols-2 gap-2">
          <Link
            href={`/dashboard/agents/${selected.id}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold whitespace-nowrap transition-colors sm:min-h-9"
          >
            Set up
          </Link>
          <a
            href={`${docsBaseUrl}/${selected.docsSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-card hover:bg-accent inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors sm:min-h-9"
          >
            <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            Docs
          </a>
        </div>
      </CardContent>
    </Card>
  )
}

export function AgentsGrid({
  agents,
  docsBaseUrl,
  publishedCliVersion,
}: {
  agents: AgentCardData[]
  docsBaseUrl: string
  publishedCliVersion: string
}) {
  const [search, setSearch] = useState("")
  const [strategy, setStrategy] = useState<"all" | InstallStrategy>("all")
  const [selectedByFamily, setSelectedByFamily] = useState<Record<string, string>>({})
  const query = search.trim().toLocaleLowerCase()

  const visibleFamilies = groupFamilies(agents)
    .map((family) => {
      const strategyAgents = family.agents.filter(
        (agent) => strategy === "all" || agent.installStrategy === strategy
      )
      const familyMatches = family.name.toLocaleLowerCase().includes(query)
      const visibleAgents = strategyAgents.filter(
        (agent) => !query || familyMatches || surfaceMatches(agent, query)
      )
      return { family, visibleAgents }
    })
    .filter(({ visibleAgents }) => visibleAgents.length > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search coding agents…"
          aria-label="Search coding agents"
          className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-10 w-full rounded-md border px-3 text-base focus-visible:ring-2 focus-visible:outline-none sm:h-9 sm:max-w-xs sm:text-sm"
        />
        <Select
          aria-label="Filter by setup strategy"
          value={strategy}
          onChange={(event) => setStrategy(event.target.value as typeof strategy)}
          className="h-10 w-full sm:h-9 sm:w-48"
        >
          <option value="all">All strategies</option>
          <option value="config-file">MCP config setup</option>
          <option value="vendor-cli">Vendor installer</option>
          <option value="guided-manual">Guided manual</option>
          <option value="agent-plugin">Agent Plugin</option>
        </Select>
      </div>

      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents registered.</p>
      ) : visibleFamilies.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          No coding agents match this search or strategy.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleFamilies.map(({ family, visibleAgents }) => (
            <AgentCard
              key={family.id}
              family={family}
              visibleAgents={visibleAgents}
              selectedId={selectedByFamily[family.id] ?? visibleAgents[0]!.id}
              onSelect={(id) => setSelectedByFamily((current) => ({ ...current, [family.id]: id }))}
              docsBaseUrl={docsBaseUrl}
              publishedCliVersion={publishedCliVersion}
            />
          ))}
        </div>
      )}
    </div>
  )
}
