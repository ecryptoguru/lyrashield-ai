import minimist from "minimist"
import { writeFile } from "node:fs/promises"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireApiKey, requireWorkspace } from "../credentials.js"
import { resolveDiffRange, runRiskyPatternChecks, buildSarif, rankSeverity } from "../diff-core.js"
import type { Output } from "../output.js"

export async function handleGate(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["fail-on", "sarif", "base", "head"],
    boolean: ["staged"],
    default: { "fail-on": "HIGH" },
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
    output.warn(`Could not run diff checks: ${err instanceof Error ? err.message : String(err)}`)
  }

  let apiFindings: { severity: string; message?: string }[] = []
  try {
    const creds = await getEffectiveCredentials()
    if (creds.apiKey) {
      const workspaceId = requireWorkspace(creds)
      const client = await createClient()
      const res = (await client.request(
        "GET",
        `/api/v1/findings?workspaceId=${encodeURIComponent(workspaceId)}`
      )) as { severity: string; message?: string }[]
      apiFindings = res
    }
  } catch (err) {
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
    await writeFile(parsed.sarif as string, JSON.stringify(sarif, null, 2), "utf-8")
  }

  if (output.json) {
    output.result({ threshold, findings: allFindings, failed: atOrAbove.length > 0 })
  } else {
    if (atOrAbove.length > 0) {
      output.error(`Gate failed: ${atOrAbove.length} finding(s) at or above ${threshold}`)
      for (const f of atOrAbove) {
        output.log(`[${f.severity}] ${f.ruleId}: ${f.message}`)
      }
    } else {
      output.log(`Gate passed: no findings at or above ${threshold}`)
    }
  }

  return atOrAbove.length > 0 ? 1 : 0
}
