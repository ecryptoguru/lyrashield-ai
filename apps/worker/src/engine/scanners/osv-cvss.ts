// CVSS is owned by FIRST and used by permission. Base metrics only, using
// https://www.first.org/cvss/v3.1/specification-document#7-1-Base-Metrics-Equations
// and its Appendix A integer rounding. CVSS 3.0 uses the same base equations.
const VALUES: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: { N: 0.85, L: 0.62, H: 0.27 },
  UI: { N: 0.85, R: 0.62 },
  S: { U: 0, C: 1 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
}

function baseScore(vector: string): number | undefined {
  const [version, ...parts] = vector.split("/")
  if (!/^CVSS:3\.[01]$/.test(version ?? "") || parts.length !== 8) return
  const metrics: Record<string, string> = Object.create(null)
  for (const part of parts) {
    const [key, value, extra] = part.split(":")
    if (
      !key ||
      !value ||
      extra !== undefined ||
      !Object.hasOwn(VALUES, key) ||
      !Object.hasOwn(VALUES[key]!, value) ||
      Object.hasOwn(metrics, key)
    )
      return
    metrics[key] = value
  }
  const weight = (key: string) => VALUES[key]![metrics[key]!]!
  const changed = metrics.S === "C"
  const iss = 1 - (1 - weight("C")) * (1 - weight("I")) * (1 - weight("A"))
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss
  if (impact <= 0) return 0
  const privileges =
    changed && metrics.PR !== "N" ? (metrics.PR === "L" ? 0.68 : 0.5) : weight("PR")
  const exploitability = 8.22 * weight("AV") * weight("AC") * privileges * weight("UI")
  const scaled = Math.round(Math.min((impact + exploitability) * (changed ? 1.08 : 1), 10) * 100000)
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10
}

/** Preserve a supported advisory base score and its exact vector, never a guess. */
export function osvCvss(
  severity?: Array<{ type: string; score: string }>
): { score: number; vector: string; source: string } | undefined {
  let result: { score: number; vector: string; source: string } | undefined
  for (const entry of severity ?? []) {
    if (entry.type !== "CVSS_V3") continue
    const score = baseScore(entry.score)
    if (score !== undefined && (!result || score > result.score))
      result = { score, vector: entry.score, source: "OSV" }
  }
  return result
}
