import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isKnownWranglerProxyFailure } from "./marketing-browser-retry-policy.mjs"

const logRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../artifacts/marketing-preview"
)

function readLogs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return readLogs(path)
    return entry.isFile() && path.endsWith(".log") ? [readFileSync(path, "utf8")] : []
  })
}

function runPlaywright(logDirectory) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "playwright", "test", "--config", "playwright.config.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, WRANGLER_LOG_PATH: logDirectory },
        stdio: "inherit",
      }
    )
    child.once("error", reject)
    child.once("close", (code, signal) => resolveResult({ code, signal }))
  })
}

mkdirSync(logRoot, { recursive: true })

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const logDirectory = resolve(logRoot, `attempt-${attempt}`)
  rmSync(logDirectory, { recursive: true, force: true })
  mkdirSync(logDirectory, { recursive: true })

  const result = await runPlaywright(logDirectory)
  if (result.code === 0) process.exit(0)

  const retryable = attempt === 1 && isKnownWranglerProxyFailure(readLogs(logDirectory))
  if (!retryable) process.exit(result.code ?? 1)

  console.error(
    "The local Wrangler dev proxy hit its known Network connection lost failure. Restarting the complete browser suite once; test failures without that exact Wrangler signature remain fatal."
  )
}

process.exitCode = 1
