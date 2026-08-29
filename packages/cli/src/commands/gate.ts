import minimist from "minimist"
import { writeFile } from "node:fs/promises"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import { loadDefaultProject } from "../projects.js"
import { resolveDiffRange, runDiffChecks, buildSarif, rankSeverity } from "../diff-core.js"
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
    line?: number
    level: string
    coverageIncomplete?: true
  }[] = []
  try {
    localFindings = await runDiffChecks(base, head)
  } catch (err) {
    hadError = true
    output.warn(`Could not run diff checks: ${err instanceof Error ? err.message : String(err)}`)
  }

  let apiFindings: { severity: string; message?: string }[] = []
  try {
    const creds = await getEffectiveCredentials()
    if (creds.apiKey) {
      const workspaceId = requireWorkspace(creds)

      // The gate must scope API findings to ONE target: fetching the whole
      // workspace merges every project's open findings into this PR's decision,
      // so an unrelated HIGH finding fails every gate. Resolution matches
      // `scan`: explicit --target wins, else the saved default project when it
      // belongs to this workspace. Without a target, only the local diff
      // checks gate this PR.
      const explicitTarget = parsed.target as string | undefined
      let targetId = explicitTarget
      if (!targetId) {
        const defaultProject = await loadDefaultProject()
        if (defaultProject?.targetId && defaultProject.workspaceId === workspaceId) {
          targetId = defaultProject.targetId
        }
      }

      if (targetId) {
        const client = await createClient()
        const items = await listAll(
          client,
          "GET",
          `/findings?workspaceId=${encodeURIComponent(workspaceId)}&targetId=${encodeURIComponent(targetId)}&status=OPEN`,
          FindingSchema
        )
        apiFindings = items.map((f) => ({ severity: f.severity, message: f.title }))
      } else if (explicitTarget === undefined) {
        output.notice(
          "No --target and no saved default project: evaluating local diff checks only."
        )
      }
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
    line?: number
    level: string
    coverageIncomplete?: true
  }[] = [
    ...localFindings,
    ...apiFindings.map((f) => ({
      ruleId: "api-finding",
      level: "error" as const,
      severity: f.severity,
      message: f.message ?? "Open finding",
      file: undefined as string | undefined,
      line: undefined as number | undefined,
    })),
  ]

  const atOrAbove = allFindings.filter((f) => rankSeverity(f.severity) >= thresholdRank)
  const incompleteCoverage = localFindings.filter((finding) => finding.coverageIncomplete)

  if (parsed.sarif) {
    const sarif = buildSarif(
      allFindings.map((f) => ({
        ruleId: f.ruleId,
        level: f.level,
        message: { text: f.message },
        locations: f.file
          ? [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.file },
                  region: f.line ? { startLine: f.line } : undefined,
                },
              },
            ]
          : undefined,
      }))
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(parsed.sarif as string, JSON.stringify(sarif, null, 2), "utf-8")
  }

  const failed = hadError || incompleteCoverage.length > 0 || atOrAbove.length > 0

  if (output.json) {
    output.result({ threshold, findings: allFindings, failed })
  } else {
    if (failed) {
      if (hadError) {
        output.error("Gate failed: could not complete the security check", 1)
      } else if (incompleteCoverage.length > 0) {
        output.error("Gate failed: WebMCP diff coverage was incomplete", 1)
      } else {
        output.error(`Gate failed: ${atOrAbove.length} finding(s) at or above ${threshold}`, 1)
      }
      for (const f of atOrAbove) {
        output.log(`[${f.severity}] ${f.ruleId}: ${f.message}`)
      }
      if (thresholdRank > rankSeverity("HIGH")) {
        for (const finding of incompleteCoverage) {
          output.log(`[${finding.severity}] ${finding.ruleId}: ${finding.message}`)
        }
      }
    } else {
      output.log(`Gate passed: no findings at or above ${threshold}`)
    }
  }

  return failed ? 1 : 0
}
