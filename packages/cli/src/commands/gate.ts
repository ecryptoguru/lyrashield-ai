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
    boolean: ["staged", "verdict"],
    default: { "fail-on": "HIGH" },
    alias: { t: "target" },
  })

  // WP5: --verdict returns the launch-gate verdict (READY / NOT_READY /
  // INSUFFICIENT_EVIDENCE) for the target with a stable exit code, instead of
  // the diff-severity gate. Exit codes: 0 READY, 1 NOT_READY, 2
  // insufficient-evidence / error. The verdict reflects the named readiness
  // standard — it never means "secure".
  if (parsed.verdict) {
    return runVerdictGate(parsed.target as string | undefined, output)
  }

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

/**
 * WP5: the launch-gate verdict as a CLI command. Queries the WP2 gate API for
 * the target and returns the readiness verdict with a stable exit code.
 *
 * Exit codes (stable contract): 0 READY, 1 NOT_READY, 2 INSUFFICIENT_EVIDENCE
 * or any error. The verdict is a gate result against the named readiness
 * standard (lyrashield-gate/1.0.0) — it never means the app is "secure".
 */
async function runVerdictGate(target: string | undefined, output: Output): Promise<number> {
  const creds = await getEffectiveCredentials()
  if (!creds.apiKey) {
    output.error("The verdict gate requires an API key. Run `lyrashield login` first.", 2)
    return 2
  }
  const workspaceId = requireWorkspace(creds)

  let targetId = target
  if (!targetId) {
    const defaultProject = await loadDefaultProject()
    if (defaultProject?.targetId && defaultProject.workspaceId === workspaceId) {
      targetId = defaultProject.targetId
    }
  }
  if (!targetId) {
    output.error("No target. Pass --target or set a default project.", 2)
    return 2
  }

  try {
    const client = await createClient()
    const res = (await client.request(
      "GET",
      `/gate/${encodeURIComponent(targetId)}?workspaceId=${encodeURIComponent(workspaceId)}`
    )) as {
      state?: string
      blockingReasons?: unknown[]
      nonCoverage?: unknown[]
      staleness?: { current?: boolean; reason?: string | null }
      standardVersion?: string
    }

    const state = res?.state ?? "INSUFFICIENT_EVIDENCE"
    const stale = res?.staleness && res.staleness.current === false

    if (output.json) {
      output.result(res)
    } else if (state === "READY") {
      output.log(`Gate verdict: READY${stale ? " (stale — re-run the gate)" : ""}`)
    } else if (state === "NOT_READY") {
      const blockers = Array.isArray(res?.blockingReasons) ? res.blockingReasons.length : 0
      output.error(
        `Gate verdict: NOT READY — ${blockers} blocking finding(s) against ${res?.standardVersion ?? "the readiness standard"}${stale ? " (stale)" : ""}`,
        1
      )
    } else {
      output.error(
        "Gate verdict: NOT ENOUGH EVIDENCE — coverage too thin to judge. Run a scan that evaluates this target.",
        2
      )
    }

    return state === "READY" ? 0 : state === "NOT_READY" ? 1 : 2
  } catch (err) {
    output.error(`Gate verdict unavailable: ${err instanceof Error ? err.message : String(err)}`, 2)
    return 2
  }
}
