import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const routingFlags = [
  "docs-only",
  "tooling-only",
  "marketing",
  "app",
  "desktop",
  "shared",
  "marketing-deploy",
  "azure-deploy",
  "marketing-tests",
  "motion-tests",
  "ops-tests",
  "engine-worker-contract",
  "database-tests",
  "database-services",
  "web-image",
  "worker-image",
  "egress-image",
  "desktop-frontend-tests",
]

export function validateRouting(outputs) {
  for (const name of routingFlags) {
    if (!["true", "false"].includes(outputs?.[name])) {
      throw new Error(`Changed-path classification omitted or corrupted ${name}`)
    }
  }
  if (outputs["database-tests"] === "true" && outputs["database-services"] !== "true") {
    throw new Error("Database tests require disposable services")
  }
  return outputs
}

export function workspaceFilters(outputs, group = "app", task) {
  validateRouting(outputs)
  if (group === "marketing") {
    return [
      ...(outputs["marketing-tests"] === "true" ? ["--filter=@lyrashield/marketing..."] : []),
      ...(outputs["motion-tests"] === "true" ? ["--filter=@lyrashield/marketing-motion..."] : []),
    ]
  }
  if (group !== "app") throw new Error(`Unknown workspace group: ${group}`)
  // Shared/unknown inputs retain all core consumers, including the SDK -> MCP
  // -> plugin -> CLI chain. App-local inputs select each app's dependency closure.
  if (outputs.shared === "true") {
    return [
      "--filter=*",
      "--filter=!@lyrashield/marketing",
      "--filter=!@lyrashield/marketing-motion",
      "--filter=!@lyrashield/desktop-frontend",
    ]
  }
  return [
    // Retained built-app browser proofs consume the web artifact even when
    // only worker sources changed. Image qualification remains independent.
    ...(outputs["web-image"] === "true" ||
    (task === "build" && outputs["database-tests"] === "true")
      ? ["--filter=@lyrashield/web..."]
      : []),
    ...(outputs["worker-image"] === "true" ? ["--filter=@lyrashield/worker..."] : []),
    // Core tests cover SDK/MCP/plugin/CLI consumers as well as the changed app.
    // Their existing typecheck dependencies materialize the three dist exports
    // before core imports them, including on a clean runner with no cache hit.
    ...(task === "typecheck" && outputs["database-tests"] === "true"
      ? ["--filter=lyrashield..."]
      : []),
  ]
}

export function validateResults(needs, cancelled = false) {
  if (cancelled) throw new Error("Workflow was cancelled during required CI checks.")
  if (!needs || typeof needs !== "object")
    throw new Error("Required CI dependency results are unavailable")
  if (needs.changes?.result !== "success")
    throw new Error("Changed-path classification did not succeed.")
  const outputs = validateRouting(needs.changes.outputs)
  if (needs["app-checks"]?.result !== "success")
    throw new Error("App/core/operations checks did not succeed")
  for (const [job, selected] of [
    [
      "marketing-checks",
      outputs["marketing-tests"] === "true" || outputs["motion-tests"] === "true",
    ],
    ["desktop-frontend", outputs["desktop-frontend-tests"] === "true"],
  ]) {
    const result = needs[job]?.result
    if (selected ? result !== "success" : result !== "skipped") {
      throw new Error(
        `${job} ${selected ? "was selected but did not succeed" : "must be intentionally skipped"}: ${result}`
      )
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, group, ...extra] = process.argv.slice(2)
  if (operation === "results") {
    validateResults(JSON.parse(process.env.CI_NEEDS ?? "null"), process.env.CI_CANCELLED === "true")
    console.log("All selected CI checks succeeded; routing receipt is complete.")
  } else {
    if (!["lint", "typecheck", "build"].includes(operation))
      throw new Error("Expected lint, typecheck, build or results")
    const filters = workspaceFilters(JSON.parse(process.env.CI_ROUTING ?? "null"), group, operation)
    if (filters.length === 0)
      throw new Error("No selected workspaces; refusing an unfiltered Turbo run")
    const args = ["exec", "turbo", "run", operation, ...filters, "--concurrency=2", ...extra]
    console.log(`pnpm ${args.join(" ")}`)
    const result = spawnSync("pnpm", args, { stdio: "inherit" })
    if (result.error) throw result.error
    process.exit(result.status ?? 1)
  }
}
