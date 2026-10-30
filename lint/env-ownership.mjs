import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

// These variables belong to another boundary. Keep exact file bindings so an
// application-wide exemption cannot silently excuse a new runtime config key.
export const externalEnvOwners = {
  CI: ["packages/cli/src/output.ts"],
  HOSTNAME: ["apps/worker/src/index.ts"],
  LOG_ANALYTICS_WORKSPACE_ID: ["apps/worker/src/operations/review-terminal-cost-disposition.ts"],
  TERMINAL_COST_AZURE_RESOURCE_ID: [
    "apps/worker/src/operations/review-terminal-cost-disposition.ts",
  ],
  LYRASHIELD_LOG_DESTINATION: ["packages/mcp/src/stdio-transport.ts"],
  LYRASHIELD_OAUTH_ACCESS_TOKEN: ["packages/credentials/src/index.ts"],
  LYRASHIELD_WORKER_STOP_RECEIPT: ["apps/worker/src/operations/verify-queue-orphan-fixture.ts"],
  LYRASHIELD_TEST_DB_DISPOSABLE: [
    "packages/config/src/env.ts",
    "packages/auth/src/password-reset-capture.ts",
    "packages/myra/src/server/password-reset-capture.ts",
  ],
  NEXT_PHASE: ["packages/config/src/env.ts", "packages/auth/src/auth.ts"],
  NEXT_RUNTIME: ["apps/web/src/instrumentation.ts"],
  NODE_TLS_REJECT_UNAUTHORIZED: ["packages/db/src/connection-config.ts"],
  NO_COLOR: ["packages/cli/src/output.ts"],
  PATH: ["apps/worker/src/engine/deterministic-retest.ts"],
  PORT: ["packages/egress-proxy/src/index.ts"],
  STRIX_SANDBOX_MIN_DISK_MB: ["apps/worker/src/jobs/preflight.job.ts"],
  VITEST: ["apps/worker/src/index.ts"],
}

export function findUnownedEnvReads(source, file, schemaKeys, owners = externalEnvOwners) {
  const missing = new Set()
  // Match literal reads only. Dynamic env maps have their own typed parsers;
  // don't imply this small audit proves complete AST/runtime parity.
  for (const match of source.matchAll(
    /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g
  )) {
    const key = match[1] ?? match[2]
    if (!schemaKeys.has(key) && !owners[key]?.includes(file)) missing.add(key)
  }
  return [...missing].sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const schema = readFileSync("packages/config/src/env.ts", "utf8")
  const keys = new Set([...schema.matchAll(/^    ([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]))
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "apps/web/src", "apps/worker/src", "packages"],
    { encoding: "utf8" }
  ).split("\0")
  const issues = []
  for (const file of files) {
    if (
      !/\.(?:ts|tsx|mts|cts)$/.test(file) ||
      /(?:\.test\.|\/(__tests__|generated|fixtures|dist)\/|\/fixtures\.ts$)/.test(file)
    )
      continue
    for (const key of findUnownedEnvReads(readFileSync(file, "utf8"), file, keys))
      issues.push(`${file}: ${key} needs a central schema field or an exact external owner`)
  }
  if (issues.length) {
    console.error(issues.join("\n"))
    process.exitCode = 1
  } else console.log("Literal runtime environment reads have declared ownership.")
}
