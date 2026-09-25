import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const kiro = JSON.parse(await readFile(path.join(root, ".mcp.kiro.json"), "utf8"))
const spec = kiro.mcpServers?.lyrashield?.args?.[1]
if (!/^@lyrashield\/mcp@\d+\.\d+\.\d+$/.test(spec ?? "")) {
  throw new Error("Kiro must pin an immutable LyraShield MCP package")
}

const version = spec.slice("@lyrashield/mcp@".length)
const response = await fetch(`https://registry.npmjs.org/@lyrashield%2fmcp/${version}`, {
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) throw new Error(`pinned MCP package is unavailable: HTTP ${response.status}`)
const metadata = await response.json()
if (metadata.name !== "@lyrashield/mcp" || metadata.version !== version) {
  throw new Error("published MCP package identity differs from the client pin")
}
if (!/^sha512-[A-Za-z0-9+/=]+$/.test(metadata.dist?.integrity ?? "")) {
  throw new Error("published MCP package has no SHA-512 integrity receipt")
}

const directory = await mkdtemp(path.join(tmpdir(), "lyrashield-mcp-release-"))
try {
  const { stdout } = await exec(
    "npm",
    [
      "pack",
      spec,
      "--ignore-scripts",
      "--json",
      "--registry=https://registry.npmjs.org",
      "--pack-destination",
      directory,
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  )
  const [packed] = JSON.parse(stdout)
  if (packed.name !== "@lyrashield/mcp" || packed.version !== version) {
    throw new Error("packed MCP package identity differs from the client pin")
  }
  const files = new Set(packed.files.map((file) => file.path))
  for (const required of ["package.json", "dist/stdio-transport.js", "bin/lyrashield-mcp.mjs"]) {
    if (!files.has(required)) throw new Error(`packed MCP package is missing ${required}`)
  }
  const archive = await readFile(path.join(directory, packed.filename))
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`
  if (integrity !== metadata.dist.integrity)
    throw new Error("published MCP package integrity differs")
  console.log(`Verified published ${spec}: integrity and stdio entrypoint`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
