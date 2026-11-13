import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function findPnpmPinDrift({ packageManager, dockerfile, scanWorkflow }) {
  const expected = packageManager.match(/^pnpm@([^\s]+)$/)?.[1]
  if (!expected) return ["package.json must declare packageManager as pnpm@<version>"]

  const dockerPins = [...dockerfile.matchAll(/corepack prepare pnpm@([^\s]+) --activate/g)].map(
    (match) => match[1]
  )
  const workflowPins = [
    ...scanWorkflow.matchAll(/(?:npm install --global|npm install -g)[^\n]*?pnpm@([^\s'"\\]+)/g),
  ].map((match) => match[1])
  const errors = []
  if (dockerPins.length !== 2) {
    errors.push(`Dockerfile must pin pnpm in both build stages; found ${dockerPins.length} pin(s)`)
  }
  if (workflowPins.length !== 1) {
    errors.push(`lyrashield-scan.yml must pin pnpm once; found ${workflowPins.length} pin(s)`)
  }
  for (const [source, pins] of [
    ["Dockerfile", dockerPins],
    ["lyrashield-scan.yml", workflowPins],
  ]) {
    for (const pin of pins) {
      if (pin !== expected) errors.push(`${source} uses pnpm@${pin}; package.json pins ${expected}`)
    }
  }
  return errors
}

async function run() {
  const [packageJson, dockerfile, scanWorkflow] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "Dockerfile"), "utf8"),
    readFile(path.join(root, ".github/workflows/lyrashield-scan.yml"), "utf8"),
  ])
  const errors = findPnpmPinDrift({
    packageManager: JSON.parse(packageJson).packageManager,
    dockerfile,
    scanWorkflow,
  })
  if (errors.length) {
    for (const error of errors) console.error(`PNPM PIN DRIFT ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`pnpm pin parity passed: ${JSON.parse(packageJson).packageManager}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await run()
}
