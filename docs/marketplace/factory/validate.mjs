import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.join(root, "plugins/lyrashield")
const canonical = path.resolve(root, "../../../packages/agent-plugin/plugin/skills")
const marketplace = JSON.parse(
  await readFile(path.join(root, ".factory-plugin/marketplace.json"), "utf8")
)
const manifest = JSON.parse(
  await readFile(path.join(plugin, ".factory-plugin/plugin.json"), "utf8")
)
const mcp = JSON.parse(await readFile(path.join(plugin, "mcp.json"), "utf8"))

assert.equal(marketplace.plugins[0].source, "./plugins/lyrashield")
assert.equal(marketplace.plugins[0].name, manifest.name)
assert.equal(mcp.mcpServers.lyrashield.type, "http")
assert.equal(mcp.mcpServers.lyrashield.url, "https://app.lyrashieldai.com/api/mcp")
assert.deepEqual(mcp.mcpServers.lyrashield.oauth.scopes, ["lyrashield.read"])
assert.doesNotMatch(JSON.stringify(mcp), /lsk_|Authorization|clientSecret/i)
const reviewCommand = await readFile(path.join(plugin, "commands/review-changes.md"), "utf8")
const scanCommand = await readFile(path.join(plugin, "commands/scan-project.md"), "utf8")
assert.match(reviewCommand, /lyrashield_check_diff/)
assert.match(reviewCommand, /Do not start a recorded scan unless the user separately requests one/)
assert.match(scanCommand, /explicitly requests one/)
assert.match(scanCommand, /Deep only when explicitly requested/)
for (const name of [
  "get-started",
  "review-changes",
  "scan-project",
  "fix-and-retest",
  "launch-readiness",
]) {
  assert.equal(
    await readFile(path.join(plugin, "skills", name, "SKILL.md"), "utf8"),
    await readFile(path.join(canonical, name, "SKILL.md"), "utf8"),
    `${name} differs from the canonical LyraShield skill`
  )
}
console.log("Factory Droid package manifests and canonical skill copies are valid.")
