import minimist from "minimist"
import { resolveDiffRange, runRiskyPatternChecks, buildSarif } from "../diff-core.js"
import type { Output } from "../output.js"

export async function handleCheckDiff(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["staged"],
    string: ["base", "head", "sarif"],
  })

  const { base, head } = resolveDiffRange(
    parsed.staged,
    parsed.base as string,
    parsed.head as string
  )

  try {
    const findings = await runRiskyPatternChecks(base, head)
    const labelled = findings.map((f) => ({ ...f, advisory: true }))

    if (parsed.sarif) {
      const { writeFile } = await import("node:fs/promises")
      const sarif = buildSarif(
        findings.map((f) => ({
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
      output.result({ advisory: true, findings: labelled })
    } else {
      output.warn("This is an advisory local check; it does not replace a LyraShield scan.")
      if (findings.length === 0) {
        output.log("No risky patterns detected in the diff.")
      } else {
        for (const f of findings) {
          output.log(`[${f.severity}] ${f.ruleId}: ${f.message}`)
        }
      }
    }

    return 0
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err))
    return 4
  }
}
