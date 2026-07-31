import type { AgentEntry } from "@lyrashield/agent-registry"
import { createClient } from "../client.js"
import { getEffectiveCredentials } from "../credentials.js"
import { redactKey } from "../output.js"
import { detectAgent, findDetectedLocations } from "../installers/detect.js"
import type { Output } from "../output.js"

export async function handleDoctor(_args: string[], output: Output): Promise<number> {
  const creds = await getEffectiveCredentials()
  const report: Record<string, unknown> = {
    apiKey: creds.apiKey ? redactKey(creds.apiKey) : "not set",
    apiUrl: creds.apiUrl,
    workspaceId: creds.workspaceId ?? "not set",
    apiKeySource: creds.source,
  }

  let apiReachable = false
  if (creds.apiKey) {
    try {
      const client = await createClient()
      const workspaces = (await client.request("GET", "/workspaces")) as unknown[]
      report.workspacesAvailable = workspaces.length
      apiReachable = true
      if (
        creds.workspaceId &&
        !workspaces.some((w) => (w as { id: string }).id === creds.workspaceId)
      ) {
        report.workspaceWarning = `Workspace ${creds.workspaceId} was not found in the available workspaces.`
      }
    } catch (err) {
      report.apiError = err instanceof Error ? err.message : String(err)
      apiReachable = false
    }
  } else {
    report.apiError = "No API key set."
  }

  const registry = await import("@lyrashield/agent-registry").catch(
    () => ({}) as Record<string, unknown>
  )
  const list = (registry as Record<string, unknown>).listAgents as (() => AgentEntry[]) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const agents = list?.() ?? arr ?? []

  const agentChecks: unknown[] = []
  for (const agent of agents) {
    const detected = await detectAgent(agent)
    const locations = await findDetectedLocations(agent)
    const configured = locations.filter((l) => l.hasEntry)
    const wrongRoot = locations.find((l) => l.exists && !l.hasEntry && l.rootKeyCorrect === false)
    const checks = {
      id: agent.id,
      displayName: agent.displayName,
      detected,
      configured: configured.map((l) => l.resolvedPath),
      wrongRoot: wrongRoot ? wrongRoot.resolvedPath : undefined,
      gotchas: agent.gotchas,
    }
    agentChecks.push(checks)
    if (wrongRoot) {
      output.warn(
        `[${agent.id}] Config found but LyraShield entry missing at the expected root key in ${wrongRoot.resolvedPath}`
      )
    }
  }

  report.agents = agentChecks

  if (creds.apiUrl?.startsWith("http://localhost")) {
    report.localhostWarning =
      "API URL points to http://localhost. This is fine for development, but production should use https://app.lyrashieldai.com."
    output.warn(report.localhostWarning as string)
  }

  if (output.json) {
    output.result(report)
  } else {
    output.log(`API key:    ${report.apiKey} (${creds.source})`)
    output.log(`API URL:    ${creds.apiUrl}`)
    output.log(`Workspace:  ${creds.workspaceId ?? "not set"}`)
    output.log(`API status: ${apiReachable ? "reachable" : "unreachable"}`)
    if (report.apiError) output.error(report.apiError as string)
    for (const check of agentChecks as {
      id: string
      displayName: string
      detected: boolean
      configured: string[]
      gotchas: string[]
    }[]) {
      output.log(`\n[${check.id}] ${check.displayName}`)
      output.log(`  detected:   ${check.detected ? "yes" : "no"}`)
      output.log(`  configured: ${check.configured.length ? check.configured.join(", ") : "no"}`)
      for (const gotcha of check.gotchas) {
        output.log(`  ! ${gotcha}`)
      }
    }
  }

  return apiReachable ? 0 : 4
}
