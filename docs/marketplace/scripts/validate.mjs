import { access, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"))
}

async function exists(relative) {
  try {
    await access(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const manifest = await readJson("manifest.json")
assert(Array.isArray(manifest.generatedFiles), "manifest.generatedFiles must be an array")
for (const relative of manifest.generatedFiles) {
  assert(await exists(relative), `missing generated artifact: ${relative}`)
}

assert(!(await exists("plugin")), "portable plugin artifacts must live at the repository root")

const portableMcp = await readJson("mcp.json")
const claudeMcp = await readJson(".mcp.json")
for (const [name, config] of Object.entries({ portableMcp, claudeMcp })) {
  const server = config.mcpServers?.lyrashield
  assert(server?.type === "streamable-http", `${name} must use Streamable HTTP`)
  assert(server?.url === "https://app.lyrashieldai.com/api/mcp", `${name} has the wrong MCP URL`)
  assert(!("headers" in server), `${name} must allow the hosted OAuth flow to authenticate`)
}

const license = await readFile(path.join(root, "LICENSE"), "utf8")
assert(
  license.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"),
  "LICENSE must contain the complete Apache-2.0 terms"
)

const openclaw = await readFile(path.join(root, "openclaw", "SKILL.md"), "utf8")
assert(openclaw.includes("license: MIT-0"), "OpenClaw skill must declare MIT-0")
assert(
  (await readFile(path.join(root, "openclaw", "LICENSE"), "utf8")).includes("MIT No Attribution"),
  "OpenClaw MIT-0 license is missing"
)

const rootEntries = await readdir(root)
assert(rootEntries.includes("plugin.json"), "root plugin.json is missing")
assert(rootEntries.includes("skills"), "root skills directory is missing")

// The marketplace catalog is what makes this repository installable rather than merely
// readable: `/plugin marketplace add` and VS Code's "Install Plugin From Source" both
// resolve plugins through it. Keep it consistent with the root plugin manifest.
const marketplace = await readJson(".claude-plugin/marketplace.json")
const rootPlugin = await readJson("plugin.json")
assert(
  typeof marketplace.name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(marketplace.name),
  "marketplace.name must be a non-empty kebab-case identifier"
)
assert(typeof marketplace.owner?.name === "string", "marketplace.owner.name is required")
assert(
  Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0,
  "marketplace.plugins must list at least one plugin"
)
const rootEntry = marketplace.plugins.find((entry) => entry.name === rootPlugin.name)
assert(rootEntry, `marketplace.plugins must list the root plugin (${rootPlugin.name})`)
assert(
  rootEntry.source === "./",
  'the root plugin entry must use source "./" so it resolves to the marketplace root'
)
assert(
  marketplace.version === rootPlugin.version && rootEntry.version === rootPlugin.version,
  "marketplace catalog versions must track plugin.json"
)

// Artifact versions recorded in the manifest must match each artifact's own
// source-of-truth file, so a version bump that skips the manifest fails here.
function parseVersion(text, pattern, label) {
  const match = text.match(pattern)
  assert(match?.[1], `could not parse ${label} version`)
  return match[1]
}

const versions = manifest.artifactVersions
assert(versions && typeof versions === "object", "manifest.artifactVersions is required")
for (const [artifact, [file, pattern, label]] of Object.entries({
  gemini: [
    "gemini-extension/gemini-extension.json",
    /"version"\s*:\s*"([^"]+)"/,
    "gemini-extension.json",
  ],
  zed: ["zed-extension/extension.toml", /^version\s*=\s*"([^"]+)"/m, "zed extension.toml"],
  codebuff: ["codebuff/lyrashield-review.ts", /^\s*version:\s*"([^"]+)"/m, "codebuff agent"],
  openclaw: ["openclaw/SKILL.md", /^version:\s*(\S+)\s*$/m, "openclaw SKILL.md"],
})) {
  const actual = parseVersion(await readFile(path.join(root, file), "utf8"), pattern, label)
  assert(
    versions[artifact] === actual,
    `manifest.artifactVersions.${artifact} (${versions[artifact]}) must match ${label} (${actual})`
  )
}

// The Gemini extension must exclude exactly the catalog-derived mutating tool
// set recorded in the manifest by the exporter.
const excluded = manifest.mutatingTools
assert(
  Array.isArray(excluded) && excluded.length > 0,
  "manifest.mutatingTools must be a non-empty array"
)
for (const name of excluded) {
  assert(
    typeof name === "string" && name.startsWith("lyrashield_"),
    `unexpected tool name in manifest.mutatingTools: ${name}`
  )
}
const geminiManifest = await readJson("gemini-extension/gemini-extension.json")
assert(
  JSON.stringify(geminiManifest.excludeTools) === JSON.stringify(excluded),
  "gemini-extension.json excludeTools must equal the manifest-recorded mutating tool set"
)
const rootGemini = await readJson("gemini-extension.json")
assert(
  JSON.stringify(rootGemini.excludeTools) === JSON.stringify(excluded),
  "root gemini-extension.json excludeTools must equal the manifest-recorded mutating tool set"
)

console.log(
  `Marketplace validation passed (${manifest.generatedFiles.length} generated artifacts).`
)
