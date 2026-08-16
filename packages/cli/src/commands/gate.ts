import minimist from "minimist"
import { writeFile } from "node:fs/promises"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import { resolveDiffRange, runRiskyPatternChecks, buildSarif, rankSeverity } from "../diff-core.js"
import { loadDefaultProject } from "../projects.js"
import type { Output } from "../output.js"
import { listAll, FindingSchema } from "@lyrashield/sdk"

export async function handleGate(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["fail-on", "sarif", "base", "head", "target"],
    boolean: ["staged"],
    default: { "fail-on": "HIGH" },
    alias: { t: "target" },
  })

  const threshold = ((parsed["fail-on"] as string) ?? "HIGH").toUpperCase()
  const thresholdRank = rankSeverity(threshold)
  if (thresholdRank === 0) {
    output.error(`Invalid --fail-on: ${threshold}`)
    return 2
  }

  const { base, head } = resolveDiffRange(
    parsed.staged,
    parsed.base as string,
    parsed.head as string
  )

  let hadError = false

  let localFindings: {
    ruleId: string
    severity: string
    message: string
    file?: string
    level: string
  }[] = []
  try {
    localFindings = await runRiskyPatternChecks(base, head)
  } catch (err) {
    hadError = true
    output.warn(`Could not run diff checks: ${err instanceof Error ? err.message : String(err)}`)
  }

  let apiFindings: { severity: string; message?: string }[] = []
  try {
    const creds = await getEffectiveCredentials()
    if (creds.apiKey) {
      const workspaceId = requireWorkspace(creds)
      // Scope the gate to one target: --target wins, then the saved default
      // project (only when it belongs to this workspace, same as scan.ts).
      // Without a targetId filter every open finding in ANY target would fail
      // every PR gate.
      let targetId = parsed.target as string | undefined
      if (!targetId) {
        const defaultProject = await loadDefaultProject()
        if (defaultProject?.targetId && defaultProject.workspaceId === workspaceId) {
          targetId = defaultProject.targetId
        }
      }
      const params = new URLSearchParams({ workspaceId, status: "OPEN" })
      if (targetId) params.set("targetId", targetId)
      const client = await createClient()
      const items = await listAll(client, "GET", `/findings?${params.toString()}`, FindingSchema)
      apiFindings = items.map((f) => ({ severity: f.severity, message: f.title }))
    }
  } catch (err) {
    hadError = true
    output.warn(
      `Could not fetch findings from API: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const allFindings: {
    ruleId: string
    severity: string
    message: string
    file?: string
    level: string
  }[] = [
    ...localFindings,
    ...apiFindings.map((f) => ({
      ruleId: "api-finding",
      level: "error" as const,
      severity: f.severity,
      message: f.message ?? "Open finding",
      file: undefined as string | undefined,
    })),
  ]

  const atOrAbove = allFindings.filter((f) => rankSeverity(f.severity) >= thresholdRank)

  if (parsed.sarif) {
    const sarif = buildSarif(
      allFindings.map((f) => ({
        ruleId: f.ruleId,
        level: f.level,
        message: { text: f.message },
        locations: f.file
          ? [{ physicalLocation: { artifactLocation: { uri: f.file } } }]
          : undefined,
      }))
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(parsed.sarif as string, JSON.stringify(sarif, null, 2), "utf-8")
  }

  const failed = hadError || atOrAbove.length > 0

  if (output.json) {
    output.result({ threshold, findings: allFindings, failed })
  } else {
    if (failed) {
      if (hadError) {
        output.error("Gate failed: could not complete the security check", 1)
      } else {
        output.error(`Gate failed: ${atOrAbove.length} finding(s) at or above ${threshold}`, 1)
      }
      for (const f of atOrAbove) {
        output.log(`[${f.severity}] ${f.ruleId}: ${f.message}`)
      }
    } else {
      output.log(`Gate passed: no findings at or above ${threshold}`)
    }
  }

  return failed ? 1 : 0
}
