import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"

if (!process.argv.includes("--confirm-production")) {
  throw new Error(
    "Production publication is locked. Re-run only after explicit final approval with --confirm-production."
  )
}

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "renders/web")
const files = readdirSync(source, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort()
const hash = createHash("sha256")
for (const file of files) hash.update(relative(source, file)).update(readFileSync(file))
const renderHash = hash.digest("hex").slice(0, 16)

for (const file of files) {
  const key = `assurance-world/v1/${renderHash}/${relative(source, file)}`
  const probe = spawnSync(
    "pnpm",
    [
      "--filter",
      "@lyrashield/marketing",
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `lyrashield-marketing-media/${key}`,
      "--file",
      "/dev/null",
      "--remote",
    ],
    {
      cwd: resolve(root, "../.."),
      stdio: "ignore",
    }
  )
  if (probe.status === 0) throw new Error(`Refusing to overwrite immutable object ${key}`)
}

for (const file of files) {
  const key = `assurance-world/v1/${renderHash}/${relative(source, file)}`
  const args = [
    "--filter",
    "@lyrashield/marketing",
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `lyrashield-marketing-media/${key}`,
    "--file",
    file,
    "--remote",
  ]
  const result = spawnSync("pnpm", args, { cwd: resolve(root, "../.."), stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Failed to publish ${key}`)
}

console.log(`Published immutable render ${renderHash}`)
