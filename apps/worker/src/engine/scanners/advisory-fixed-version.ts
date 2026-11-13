import type { OsvVulnerability } from "@lyrashield/db"
import type { Dependency } from "./dependency-manifests"

function compare(left: number[], right: number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta) return delta
  }
  return 0
}

/** Conservative numeric release subsets, not a semver coercion of other ecosystems. */
function release(version: string, ecosystem: string, introduced = false): number[] | undefined {
  const parts = version.replace(ecosystem === "PyPI" ? /^$/ : /^v/, "").split(".")
  const maximum = ecosystem === "PyPI" ? 4 : 3
  const minimum = ecosystem === "PyPI" || (ecosystem === "Packagist" && introduced) ? 1 : 3
  if (
    parts.length < minimum ||
    parts.length > maximum ||
    !parts.every(
      (part) =>
        /^\d{1,6}$/.test(part) && (ecosystem !== "npm" || part === "0" || !part.startsWith("0"))
    )
  )
    return undefined
  return parts.map(Number)
}

/** A fix must close the installed release's interval for this exact package/ecosystem. */
export function selectFixedVersion(
  vuln: OsvVulnerability,
  dependency: Dependency
): string | undefined {
  const { ecosystem, name } = dependency
  if (!["npm", "PyPI", "Packagist"].includes(ecosystem)) return undefined
  const installed = release(dependency.version, ecosystem)
  if (!installed) return undefined
  const normalizeName = (value: string) =>
    ecosystem === "PyPI" ? value.toLowerCase().replace(/[-_.]+/g, "-") : value
  const candidates: string[] = []
  const intervals: Array<{ from: number[]; to?: number[]; inclusive?: boolean }> = []
  for (const affected of vuln.affected ?? []) {
    if (
      !affected.package ||
      affected.package.ecosystem !== ecosystem ||
      normalizeName(affected.package.name) !== normalizeName(name)
    )
      continue
    if (!affected.ranges?.length) return undefined
    for (const range of affected.ranges) {
      const supportedType =
        ecosystem === "npm"
          ? range.type === "SEMVER"
          : ecosystem === "PyPI"
            ? range.type === "ECOSYSTEM"
            : ["ECOSYSTEM", "SEMVER"].includes(range.type ?? "")
      if (!supportedType) return undefined
      let from: number[] | undefined
      for (const event of range.events) {
        if (event.introduced !== undefined) {
          if (from) return undefined
          from = event.introduced === "0" ? [0] : release(event.introduced, ecosystem, true)
          if (!from) return undefined
        } else if (event.fixed !== undefined || event.last_affected !== undefined) {
          const end = event.fixed ?? event.last_affected!
          const to = release(end, ecosystem)
          if (!from || !to || compare(from, to) > 0) return undefined
          intervals.push({ from, to, inclusive: event.last_affected !== undefined })
          if (event.fixed && compare(installed, from) >= 0 && compare(installed, to) < 0)
            candidates.push(event.fixed)
          from = undefined
        } else return undefined
      }
      if (from) intervals.push({ from })
    }
  }
  return candidates
    .filter((candidate) => {
      const version = release(candidate, ecosystem)!
      return !intervals.some(
        ({ from, to, inclusive }) =>
          compare(version, from) >= 0 &&
          (!to || compare(version, to) < 0 || (inclusive && compare(version, to) === 0))
      )
    })
    .sort((left, right) => compare(release(left, ecosystem)!, release(right, ecosystem)!))[0]
}
