import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const runFile = promisify(execFile)
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
  const { stdout } = await runFile(
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
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", spec], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        LYRASHIELD_API_KEY: `lsk_${"A".repeat(24)}`,
        LYRASHIELD_API_URL: "http://127.0.0.1:9",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buffer = ""
    let ready = false
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "marketplace-release-check", version: "1" },
        },
      })}\n`
    )
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      let end
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let response
        try {
          response = JSON.parse(line)
        } catch {
          child.kill()
          reject(new Error("published MCP wrote non-JSON-RPC stdout"))
          return
        }
        if (response.id === 1) {
          if (!response.result?.serverInfo) {
            child.kill()
            reject(new Error("published MCP initialization failed"))
            return
          }
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
          )
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`
          )
        } else if (response.id === 2) {
          if (!Array.isArray(response.result?.tools) || response.result.tools.length < 10) {
            child.kill()
            reject(new Error("published MCP tool catalog is incomplete"))
            return
          }
          ready = true
          child.kill()
        }
      }
    })
    child.on("error", reject)
    child.on("close", () => {
      clearTimeout(timer)
      if (ready) resolve()
      else reject(new Error("published MCP stdio server did not respond"))
    })
  })
  console.log(`Verified published ${spec}: integrity, entrypoint and stdio tools`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
