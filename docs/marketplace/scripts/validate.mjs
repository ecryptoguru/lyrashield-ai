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

console.log(`Marketplace validation passed (${manifest.generatedFiles.length} generated artifacts).`)
