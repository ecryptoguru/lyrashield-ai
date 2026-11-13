import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))
const canonical = path.resolve(root, "../../../packages/agent-plugin/plugin/skills")
const extension = JSON.parse(await readFile(path.join(root, "qwen-extension.json"), "utf8"))

assert.equal(extension.name, "lyrashield")
assert.equal(extension.skills, "skills")
assert.equal(extension.commands, "commands")
assert.equal(extension.mcpServers.lyrashield.httpUrl, "https://app.lyrashieldai.com/api/mcp")
assert.equal(extension.mcpServers.lyrashield.oauth.enabled, true)
assert.deepEqual(extension.mcpServers.lyrashield.oauth.scopes, ["lyrashield.read"])
assert.doesNotMatch(JSON.stringify(extension.mcpServers), /lsk_|Authorization|clientSecret/i)
const reviewCommand = await readFile(path.join(root, "commands/review-changes.md"), "utf8")
const scanCommand = await readFile(path.join(root, "commands/scan-project.md"), "utf8")
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
    await readFile(path.join(root, "skills", name, "SKILL.md"), "utf8"),
    await readFile(path.join(canonical, name, "SKILL.md"), "utf8"),
    `${name} differs from the canonical LyraShield skill`
  )
}
console.log("Qwen extension manifest and canonical skill copies are valid.")
