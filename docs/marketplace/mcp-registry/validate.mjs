import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../../")
const pluginRequire = createRequire(path.join(repoRoot, "packages/agent-plugin/package.json"))
const Ajv = pluginRequire("ajv").default
const expectedSchemaSha256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0"
const schemaPath = path.join(here, "schema/server.schema.json")
const manifestPath = path.join(here, "server.json")
const packagePath = path.join(repoRoot, "packages/mcp/package.json")

const [schemaText, manifestText, packageText] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(packagePath, "utf8"),
])

const schemaHash = createHash("sha256").update(schemaText).digest("hex")
if (schemaHash !== expectedSchemaSha256) {
  console.error("Vendored official schema checksum mismatch: " + schemaHash)
  process.exit(1)
}

const schema = JSON.parse(schemaText)
const manifest = JSON.parse(manifestText)
const packageJson = JSON.parse(packageText)
const ajv = new Ajv({ allErrors: true, strict: false })
ajv.addFormat("uri", {
  type: "string",
  validate(value) {
    try {
      return new URL(value).protocol.length > 0
    } catch {
      return false
    }
  },
})

const validate = ajv.compile(schema)
const errors = []
if (!validate(manifest)) {
  errors.push(...(validate.errors ?? []).map(({ instancePath, message }) => (instancePath || "/") + " " + message))
}

if (packageJson.name !== "@lyrashield/mcp") errors.push("Local package identity must remain @lyrashield/mcp")
if (manifest.packages?.length !== 1 || manifest.packages[0].identifier !== packageJson.name) {
  errors.push("server.json must describe the @lyrashield/mcp npm package")
}
if (manifest.version !== packageJson.version || manifest.packages?.[0]?.version !== packageJson.version) {
  errors.push("server.json versions must match local package " + packageJson.version)
}
if (manifest.name !== "io.github.ecryptoguru/lyrashield-ai") {
  errors.push("server.json name must match the prepared GitHub identity")
}
if (manifest.remotes?.length !== 1 || manifest.remotes[0].url !== "https://app.lyrashieldai.com/api/mcp") {
  errors.push("server.json must describe the documented hosted MCP endpoint")
}
if (packageJson.mcpName !== undefined && packageJson.mcpName !== manifest.name) {
  errors.push("package.json mcpName must equal server.json name " + manifest.name)
}
if (process.argv.includes("--release-ready")) {
  if (packageJson.mcpName !== manifest.name) {
    errors.push("package.json mcpName must equal server.json name " + manifest.name)
  } else {
    const npmView = spawnSync(
      "npm",
      ["view", packageJson.name + "@" + packageJson.version, "mcpName", "--json"],
      { encoding: "utf8" }
    )
    let publishedMcpName
    try {
      publishedMcpName = JSON.parse(npmView.stdout.trim())
    } catch {
      publishedMcpName = undefined
    }
    if (npmView.status !== 0 || publishedMcpName !== manifest.name) {
      errors.push("the published npm package must expose the matching mcpName before submission")
    }
  }
}

if (errors.length) {
  console.error("MCP Registry metadata validation failed:")
  for (const error of errors) console.error("- " + error)
  process.exit(1)
}

console.log("MCP Registry metadata passes the vendored official schema (package " + packageJson.version + ").")
if (!process.argv.includes("--release-ready")) {
  console.log("PREPARATION ONLY: local package and Registry ownership markers match; publish the package and verify npm before submission.")
} else if (packageJson.mcpName !== manifest.name) {
  console.warn("PREPARATION ONLY: next npm release must set mcpName to " + manifest.name + ".")
} else {
  console.log("Published npm ownership marker matches; run mcp-publisher validate before submission.")
}
