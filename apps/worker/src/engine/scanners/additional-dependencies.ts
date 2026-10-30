import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { DEPENDENCY_RESOLUTION_CAPABILITIES } from "@lyrashield/types"
import {
  parseCargoLock,
  parseGemfileLock,
  type EcosystemResolution,
} from "./ecosystem-lock-parsers"
import { resolveGoModules, type GoResolutionReceipt } from "./go-module-resolver"

export const ADDITIONAL_DEPENDENCY_INPUTS = new Set([
  ...DEPENDENCY_RESOLUTION_CAPABILITIES.filter((capability) =>
    ["crates.io", "RubyGems", "Go"].includes(capability.ecosystem)
  ).flatMap((capability) => [...capability.inputs]),
  "Cargo.toml",
  "Gemfile",
  "go.sum",
  "go.work.sum",
])
export async function resolveAdditionalDependencies(
  inputs: Map<string, string>,
  options: { signal?: AbortSignal; deadline: number }
): Promise<EcosystemResolution & { goReceipt?: GoResolutionReceipt; evidence: string }> {
  const result: EcosystemResolution & { goReceipt?: GoResolutionReceipt; evidence: string } = {
    packages: [],
    unresolved: [],
    evidence: "",
  }
  const goInputs = new Map<string, string>()
  for (const [path, content] of inputs) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (Date.now() >= options.deadline || result.unresolved.length >= 500) {
      result.unresolved.push({
        ecosystem: "unknown",
        name: path,
        reason: "Additional dependency resolution deadline or issue limit reached",
      })
      break
    }
    if (options.signal?.aborted) throw new Error("Dependency resolution cancelled")
    const name = basename(path)
    if (name.startsWith("go.")) {
      goInputs.set(path, content)
      continue
    }
    if (name === "Cargo.toml" || name === "Gemfile") {
      const lock = name === "Cargo.toml" ? "Cargo.lock" : "Gemfile.lock"
      // An ancestor lockfile is not proof of workspace membership.
      const directory = dirname(path)
      if (!inputs.has(join(directory, lock)))
        result.unresolved.push({
          ecosystem: name === "Cargo.toml" ? "crates.io" : "RubyGems",
          name: path,
          reason: "Dependency manifest has no supported exact lockfile",
        })
      continue
    }
    const parsed =
      name === "Cargo.lock" ? parseCargoLock(content, path) : parseGemfileLock(content, path)
    const remaining = Math.max(0, 500 - result.packages.length)
    result.packages.push(...parsed.packages.slice(0, remaining))
    if (parsed.packages.length > remaining)
      result.unresolved.push({
        ecosystem: "unknown",
        name: path,
        reason: "Additional dependency package limit reached",
      })
    result.unresolved.push(...parsed.unresolved.slice(0, 500 - result.unresolved.length))
  }
  if (goInputs.size) {
    const go = await resolveGoModules(goInputs, options)
    result.packages.push(...go.packages)
    result.unresolved.push(...go.unresolved)
    result.goReceipt = go.receipt
  }
  result.evidence = JSON.stringify({
    schemaVersion: 1,
    kind: "dependency-resolution",
    inputs: [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    packages: result.packages,
    unresolved: result.unresolved,
    go: result.goReceipt,
  })
  return result
}
