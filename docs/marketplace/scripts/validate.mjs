import { access, readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
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

// Enforce manifest.forbidden — none of the listed paths may be present anywhere
// (including nested) in the export. The generator is the only writer; this
// catches a hand-edited artifact or a mis-configured export that leaks private paths.
assert(Array.isArray(manifest.forbidden), "manifest.forbidden must be an array")
for (const forbidden of manifest.forbidden) {
  assert(!existsSync(path.join(root, forbidden)), `forbidden path present in export: ${forbidden}`)
}
// Nested forbidden: reject .env*, credential files, private keys, PEM/cert stores,
// provider tokens, or any file whose path contains a forbidden segment.
const NESTED_FORBIDDEN_BASENAME =
  /^\.env(\..*)?$|^credentials(\.json)?$|\.pem$|\.key$|\.p12$|\.pfx$|\.crt$|\.cert$/i
const NESTED_FORBIDDEN_SEGMENTS = manifest.forbidden.map((p) => p.replace(/^\//, "").split("/")[0])
async function scanForbidden(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    // Basename-level forbidden (covers nested .env*, *.pem, etc.)
    if (NESTED_FORBIDDEN_BASENAME.test(entry.name)) {
      throw new Error(`forbidden file present (nested): ${rel}`)
    }
    // Segment-level forbidden (e.g. apps/web nested anywhere)
    const segments = rel.split(path.sep)
    for (const seg of NESTED_FORBIDDEN_SEGMENTS) {
      if (segments.includes(seg)) throw new Error(`forbidden path present (nested): ${rel}`)
    }
    if (entry.isDirectory()) await scanForbidden(full)
  }
}
await scanForbidden(root)

// Scan tracked text files for leaked secrets. LyraShield keys (lsk_…) are the
// primary product credential, but the marketplace must also reject private
// keys, PEM blocks, and common provider token shapes. Placeholders are
// allowlisted so install guides can document the variables safely.
const KEY_PATTERN = /lsk_[A-Za-z0-9]{8,}/
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA )?PRIVATE KEY-----/
const PEM_PATTERN = /-----BEGIN (?:CERTIFICATE|PRIVATE KEY|PUBLIC KEY)-----/
const PROVIDER_TOKEN_PATTERN =
  /(?:ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,})/
const PLACEHOLDER_PATTERN = /lsk_[….]|<YOUR_/
async function scanSecrets(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full)
    // Never flag the validator's own pattern definitions as leaked secrets.
    if (rel === "scripts/validate.mjs") continue
    if (entry.isDirectory()) {
      await scanSecrets(full)
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      const textish = [
        ".md",
        ".json",
        ".ts",
        ".js",
        ".mjs",
        ".yml",
        ".yaml",
        ".toml",
        ".txt",
        "",
      ].includes(ext)
      if (!textish) continue
      const content = await readFile(full, "utf8")
      for (const [index, line] of content.split("\n").entries()) {
        if (PLACEHOLDER_PATTERN.test(line)) continue
        const location = `${path.relative(root, full)}:${index + 1}`
        if (KEY_PATTERN.test(line))
          throw new Error(`real LyraShield API key detected at ${location}`)
        if (PRIVATE_KEY_PATTERN.test(line) || PEM_PATTERN.test(line))
          throw new Error(`private key/PEM detected at ${location}`)
        if (PROVIDER_TOKEN_PATTERN.test(line))
          throw new Error(`provider token detected at ${location}`)
      }
    }
  }
}
await scanSecrets(root)

const portableMcp = await readJson("mcp.json")
const claudeMcp = await readJson(".mcp.json")
for (const [name, config] of Object.entries({ portableMcp, claudeMcp })) {
  const server = config.mcpServers?.lyrashield
  assert(server?.type === "http", `${name} must use Streamable HTTP`)
  assert(server?.url === "https://app.lyrashieldai.com/api/mcp", `${name} has the wrong MCP URL`)
  assert(!("headers" in server), `${name} must allow the hosted OAuth flow to authenticate`)
}

// Cursor shim inlines MCP config — same invariants as root configs.
const cursorPlugin = await readJson(".cursor-plugin/plugin.json")
const cursorServer = cursorPlugin.mcpServers?.lyrashield
assert(cursorServer, ".cursor-plugin/plugin.json must declare the lyrashield MCP server")
assert(
  cursorServer.type === "http",
  ".cursor-plugin/plugin.json lyrashield server must use Streamable HTTP"
)
assert(
  cursorServer.url === "https://app.lyrashieldai.com/api/mcp",
  ".cursor-plugin/plugin.json lyrashield server has the wrong MCP URL"
)
assert(
  !("headers" in cursorServer),
  ".cursor-plugin/plugin.json must allow the hosted OAuth flow to authenticate"
)

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
  assert(actual === rootPlugin.version, `${artifact} version must track plugin.json`)
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

const expectedPackage = "@lyrashield/mcp@0.2.2"
for (const file of [
  ".mcp.kiro.json",
  "gemini-extension.json",
  "gemini-extension/gemini-extension.json",
  "codebuff/lyrashield-review.ts",
  "zed-extension/src/lib.rs",
  "kilo/mcps/lyrashield/MCP.yaml",
]) {
  const text = await readFile(path.join(root, file), "utf8")
  assert(
    !text.includes("LYRASHIELD_API_URL"),
    `${file} must not override OAuth credential-store provenance`
  )
  if (file.endsWith(".rs")) {
    assert(
      text.includes('const PACKAGE_VERSION: &str = "0.2.2";'),
      "Zed must pin the published MCP version"
    )
    assert(!text.includes("npm_package_latest_version"), "Zed must not install a floating release")
  } else {
    assert(text.includes(expectedPackage), `${file} must pin the published MCP version`)
  }
}
assert(
  geminiManifest.settings[0].envVar === "GEMINI_LYRASHIELD_CRED",
  "Gemini setting must survive environment redaction"
)
assert(
  geminiManifest.mcpServers.lyrashield.env.LYRASHIELD_API_KEY === "${GEMINI_LYRASHIELD_CRED}",
  "Gemini must explicitly map the credential"
)
const codebuff = await readFile(path.join(root, "codebuff/lyrashield-review.ts"), "utf8")
assert(
  !codebuff.includes("run_terminal_command"),
  "Read-only Codebuff agent must not run shell commands"
)
for (const file of [
  "skills/lyrashield/SKILL.md",
  "openclaw/SKILL.md",
  "kiro-power/POWER.md",
  "GEMINI.md",
]) {
  const text = await readFile(path.join(root, file), "utf8")
  assert(
    text.includes("lyrashield_check_diff") && text.includes("lyrashield_verify_fix"),
    `${file} must use canonical tools`
  )
  assert(
    text.includes(
      "Fixes are proposals that require human review and approval; nothing is applied automatically."
    ),
    `${file} must preserve human approval`
  )
}

console.log(
  `Marketplace validation passed (${manifest.generatedFiles.length} generated artifacts).`
)
