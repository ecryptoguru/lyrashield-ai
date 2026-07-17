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
const sentinelRelativePath = "desktop/gateway.mp4"
const files = readdirSync(source, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort((left, right) => {
    const leftRelative = relative(source, left)
    const rightRelative = relative(source, right)
    if (leftRelative === sentinelRelativePath) return -1
    if (rightRelative === sentinelRelativePath) return 1
    return leftRelative.localeCompare(rightRelative)
  })
const hash = createHash("sha256")
for (const file of files) hash.update(relative(source, file)).update(readFileSync(file))
const renderHash = hash.digest("hex").slice(0, 16)

const publishRoot = `assurance-world/v1/${renderHash}`
const sentinelProbe = spawnSync(
  "pnpm",
  [
    "--filter",
    "@lyrashield/marketing",
    "exec",
    "wrangler",
    "r2",
    "object",
    "get",
    `lyrashield-marketing-media/${publishRoot}/${sentinelRelativePath}`,
    "--file",
    "/dev/null",
    "--remote",
  ],
  {
    cwd: resolve(root, "../.."),
    stdio: "ignore",
  }
)
if (sentinelProbe.status === 0) {
  throw new Error(`Refusing to overwrite immutable render ${publishRoot}`)
}

const contentTypes = {
  avif: "image/avif",
  jpg: "image/jpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  webp: "image/webp",
}

for (const file of files) {
  const key = `${publishRoot}/${relative(source, file)}`
  const extension = file.slice(file.lastIndexOf(".") + 1)
  const contentType = contentTypes[extension]
  if (!contentType) throw new Error(`Unsupported media type for ${file}`)
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
    "--content-type",
    contentType,
    "--cache-control",
    "public, max-age=31536000, immutable",
    "--remote",
  ]
  const result = spawnSync("pnpm", args, { cwd: resolve(root, "../.."), stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Failed to publish ${key}`)
}

console.log(`Published immutable render ${renderHash}`)
