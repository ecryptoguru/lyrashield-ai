import type { AgentEntry } from "@lyrashield/agent-registry"
import { getSetupHealth, type SetupHealthSnapshot } from "@lyrashield/sdk"
import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, getOfflineCredentials } from "../credentials.js"
import { redactKey } from "../output.js"
import { detectAgent, findDetectedLocations } from "../installers/detect.js"
import type { Output } from "../output.js"

function parseDoctorArgs(args: string[]) {
  const parsed = minimist(args, {
    boolean: ["strict", "offline", "help"],
    string: ["workspace", "target", "goal", "mode", "workflow", "policy"],
    alias: { w: "workspace", h: "help" },
  })
  return parsed
}

async function collectAgentChecks(output: Output): Promise<unknown[]> {
  const registry = await import("@lyrashield/agent-registry").catch(() => ({}))
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
  return agentChecks
}

function renderDoctorTextReport(
  output: Output,
  report: Record<string, unknown>,
  context: {
    credential: string
    credentialSource: string
    apiUrl: string | undefined
    workspaceId: string | null | undefined
    apiReachable: boolean
    setupHealth: SetupHealthSnapshot | null
    agentChecks: unknown[]
  }
) {
  output.log(`Credential: ${context.credential} (${context.credentialSource})`)
  output.log(`API URL:    ${context.apiUrl}`)
  output.log(`Workspace:  ${context.workspaceId ?? "not set"}`)
  output.log(`API status: ${context.apiReachable ? "reachable" : "unreachable"}`)
  if (report.apiError) {
    output.error(report.apiError as string)
    for (const step of (report.apiRemedy as string[] | undefined) ?? []) {
      output.log(`  → ${step}`)
    }
  }
  if (report.workspaceWarning) {
    output.warn(report.workspaceWarning as string)
    if (report.workspaceRemedy) output.log(`  → ${report.workspaceRemedy as string}`)
  }
  const setupHealth = context.setupHealth
  if (setupHealth) {
    output.log(`Setup:     ${setupHealth.status}`)
    const primary = setupHealth.checks.find((check) => check.code === setupHealth.primaryCheck)
    if (primary) {
      output.log(`  ${primary.code}: ${primary.explanation}`)
      if (primary.recoveryAction)
        output.log(`  Next: ${primary.recoveryAction.replaceAll("_", " ").toLowerCase()}`)
    }
  }
  for (const check of context.agentChecks as {
    id: string
    displayName: string
    detected: boolean
    configured: string[]
    gotchas: string[]
  }[]) {
    output.log(`\n[${check.id}] ${check.displayName}`)
    output.log(`  detected:   ${check.detected ? "yes" : "no"}`)
    output.log(`  configured: ${check.configured.length ? check.configured.join(", ") : "no"}`)
    // Gotchas for an agent the user doesn't have are pure noise; only surface
    // them once the agent is actually present or configured.
    if (check.detected || check.configured.length > 0) {
      for (const gotcha of check.gotchas) {
        output.log(`  ! ${gotcha}`)
      }
    }
  }
}

export async function handleDoctor(args: string[], output: Output): Promise<number> {
  const parsed = parseDoctorArgs(args)
  // `--offline` must not refresh an expired OAuth token over the network.
  const creds = parsed.offline ? await getOfflineCredentials() : await getEffectiveCredentials()
  const credential =
    creds.credentialKind === "oauth"
      ? "OAuth access token"
      : creds.apiKey
        ? redactKey(creds.apiKey)
        : "not set"
  const report: Record<string, unknown> = {
    credential,
    credentialKind: creds.credentialKind,
    credentialSource: creds.source,
    // Preserve the existing JSON field for API-key consumers without
    // misclassifying OAuth access tokens as third-party API keys.
    apiKey: creds.credentialKind === "api-key" ? redactKey(creds.apiKey) : "not set",
    apiUrl: creds.apiUrl,
    workspaceId: parsed.workspace ?? creds.workspaceId ?? "not set",
    apiKeySource: creds.source,
  }

  let apiReachable = false
  let setupHealth: SetupHealthSnapshot | null = null
  if (creds.apiKey && !parsed.offline) {
    try {
      const client = await createClient()
      const workspaces = (await client.request("GET", "/workspaces")) as {
        id: string
        name?: string
      }[]
      report.workspacesAvailable = workspaces.length
      apiReachable = true
      const workspaceId = parsed.workspace ?? creds.workspaceId
      if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) {
        // Naming the alternatives is the difference between a dead end and a
        // fix: the id alone is an opaque cuid the user cannot act on.
        report.workspaceWarning = `Workspace ${workspaceId} was not found in the available workspaces.`
        report.availableWorkspaces = workspaces.map((w) => ({ id: w.id, name: w.name }))
        report.workspaceRemedy = workspaces.length
          ? `Switch with: lyrashield use <workspaceId> — available: ${workspaces
              .map((w) => (w.name ? `${w.id} (${w.name})` : w.id))
              .join(", ")}`
          : "This API key can't see any workspaces. Check that the key belongs to the right workspace."
      }

      if (typeof parsed.target === "string" && parsed.target.trim()) {
        try {
          setupHealth = await getSetupHealth(client, {
            ...(workspaceId ? { workspaceId } : {}),
            targetId: parsed.target.trim(),
            goal: typeof parsed.goal === "string" && parsed.goal ? parsed.goal : "TEST_APP",
            mode: typeof parsed.mode === "string" && parsed.mode ? parsed.mode : "QUICK",
            workflow:
              parsed.workflow === "REVIEW_CHANGES" ||
              parsed.workflow === "AUTHENTICATED_ASSESSMENT" ||
              parsed.workflow === "REVIEW_TARGET"
                ? parsed.workflow
                : "REVIEW_TARGET",
            ...(typeof parsed.policy === "string" && parsed.policy
              ? { policyId: parsed.policy }
              : {}),
          })
          report.setupHealth = setupHealth
        } catch (error) {
          report.setupHealthError =
            error instanceof Error ? error.message : "Setup health could not be checked"
        }
      }
    } catch (err) {
      report.apiError = err instanceof Error ? err.message : String(err)
      report.apiRemedy = [
        `Check LYRASHIELD_API_URL — currently ${creds.apiUrl}`,
        "Re-authenticate if the key is expired or revoked: lyrashield login",
        "Confirm outbound HTTPS to the API host is not blocked by a proxy or firewall",
      ]
      apiReachable = false
    }
  } else if (parsed.offline) {
    report.apiReachable = null
    report.apiStatus = "skipped (offline)"
  } else {
    report.apiError = "No API key set."
    report.apiRemedy = [
      "Set one with: lyrashield login",
      "Or export LYRASHIELD_API_KEY=lsk_… for CI",
    ]
  }

  const agentChecks = await collectAgentChecks(output)

  report.agents = agentChecks

  if (creds.apiUrl?.startsWith("http://localhost")) {
    report.localhostWarning =
      "API URL points to http://localhost. This is fine for development, but production should use https://app.lyrashieldai.com."
    output.warn(report.localhostWarning as string)
  }

  if (output.json) {
    output.result(report)
  } else {
    renderDoctorTextReport(output, report, {
      credential,
      credentialSource: creds.source,
      apiUrl: creds.apiUrl,
      workspaceId: creds.workspaceId,
      apiReachable,
      setupHealth,
      agentChecks,
    })
  }

  if (parsed.strict) {
    if (setupHealth?.status === "unknown" || report.setupHealthError) return 6
    if (setupHealth?.status === "blocked") return 5
  }
  if (parsed.offline) return creds.apiKey ? 0 : 4
  return apiReachable ? 0 : 4
}
